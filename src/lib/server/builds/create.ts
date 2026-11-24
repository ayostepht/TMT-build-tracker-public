import { and, eq } from 'drizzle-orm';
import { MAX_CUSTOM_PIECES, MAX_CUSTOM_PLATES } from '#lib/domain/custom.ts';
import type { BuildKind, BuildPrinter, BuildView } from '#lib/domain/types.ts';
import { resolveChoices, validateChoices } from '#lib/domain/variants.ts';
import { ApiError, requireEditor } from '../access';
import { canSeeDesign } from '../designs/access';
import { arrangeForPrinter } from './plates';
import { loadBuildView } from './view';
import { applyLibraryPieceTx, defaultLibraryRows, lockLibraryRow } from '../custom-library';
import { first, one, type Db } from '../db';
import { BUILD_HOSPITAL_MAX, BUILD_NAME_MAX, BUILD_RECIPIENT_MAX } from './limits';
import { assertUnder, countBuilds, countDrafts } from '../quota';
import {
	activity,
	buildFilaments,
	buildParts,
	buildPlates,
	builds,
	colorDesigns,
	templateFilamentRoles,
	templateParts,
	templatePlateLayouts,
	templatePlates,
	templates
} from '../db/schema';

export interface CreateBuildInput {
	organizationId: string;
	templateId: string;
	designId: string | null;
	name: string;
	recipient?: string | null;
	hospital?: string | null;
	deliveryDate?: string | null;
	/** group key → option key; groups left out get the template default. Unknown keys are rejected. */
	variantChoices?: Record<string, string> | null;
	/** A built-in plate layout key (`template_plate_layouts`); omitted = the template's default plates. */
	plateLayout?: string | null;
	/** Printer to plan plates for (BuildPrinter, validated). With one set, plates are arranged right away unless a layout is chosen. */
	printer?: BuildPrinter | null;
	/** 'draft' creates a Studio draft: no setup wizard, no tracking. Default 'build'. */
	kind?: BuildKind;
	/** Start the setup wizard at step 1 (the New build form); API-created builds skip it. */
	setup?: boolean;
}

function freeText(v: unknown, field: string, max: number): string | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'string' || v.length > max)
		throw new ApiError(400, `${field} must be text of at most ${max} characters`);
	return v.trim() || null;
}

/** Multi-row insert in chunks (well under Postgres' 65535 bind parameters per statement). */
async function insertRows<T>(rows: T[], run: (chunk: T[]) => PromiseLike<unknown>): Promise<void> {
	for (let i = 0; i < rows.length; i += 500) await run(rows.slice(i, i + 500));
}

/** Create a build from a template (and optional color design) in one transaction. Returns the new id. */
export async function createBuild(
	db: Db,
	input: CreateBuildInput,
	userId: string
): Promise<string> {
	await requireEditor(db, input.organizationId, userId);
	if (typeof input.name !== 'string') throw new ApiError(400, 'Name is required');
	const name = input.name.trim().slice(0, BUILD_NAME_MAX);
	if (!name) throw new ApiError(400, 'Name is required');
	const recipient = freeText(input.recipient, 'recipient', BUILD_RECIPIENT_MAX);
	const hospital = freeText(input.hospital, 'hospital', BUILD_HOSPITAL_MAX);
	if (input.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate))
		throw new ApiError(400, 'Delivery date must be YYYY-MM-DD');

	// `db.transaction` exists on a Db; a caller already inside a transaction (a Tx) is nested as a savepoint.
	const newId = await db.transaction(async (tx) => {
		// Count and insert under an advisory lock (taken by assertUnder): parallel requests cannot both pass.
		if (input.kind === 'draft')
			await assertUnder(tx, 'draftsPerUser', () => countDrafts(tx, userId), { userId });
		else
			await assertUnder(tx, 'buildsPerWorkspace', () => countBuilds(tx, input.organizationId), {
				userId,
				scope: input.organizationId
			});
		const tpl = await first(tx.select().from(templates).where(eq(templates.id, input.templateId)));
		// A workspace-owned kit copy is usable only in the workspace that owns it.
		if (!tpl || (tpl.ownerOrgId && tpl.ownerOrgId !== input.organizationId))
			throw new ApiError(400, 'Unknown template');

		const choices = input.variantChoices ?? {};
		const badChoice = validateChoices(tpl.variantGroups, choices);
		if (badChoice) throw new ApiError(400, badChoice);

		const layout = input.plateLayout
			? await first(
					tx
						.select()
						.from(templatePlateLayouts)
						.where(
							and(
								eq(templatePlateLayouts.templateId, tpl.id),
								eq(templatePlateLayouts.key, input.plateLayout)
							)
						)
				)
			: undefined;
		if (input.plateLayout && !layout) throw new ApiError(400, 'Unknown plate layout');

		let design: typeof colorDesigns.$inferSelect | undefined;
		if (input.designId) {
			design = await first(
				tx.select().from(colorDesigns).where(eq(colorDesigns.id, input.designId))
			);
			if (!design || design.templateId !== tpl.id || !(await canSeeDesign(tx, design, userId)))
				throw new ApiError(400, 'Unknown design');
		}

		const { id } = await one(
			tx
				.insert(builds)
				.values({
					organizationId: input.organizationId,
					templateId: tpl.id,
					name,
					recipient,
					hospital,
					deliveryDate: input.deliveryDate || null,
					design: design
						? {
								id: design.id,
								slug: design.slug,
								name: design.name,
								roles: design.roles,
								partRoles: design.partRoles
							}
						: null,
					variantChoices: resolveChoices(tpl.variantGroups, choices),
					plateLayout: layout?.key ?? null,
					printer: input.printer ?? null,
					kind: input.kind === 'draft' ? 'draft' : 'build',
					setupStep: input.setup && input.kind !== 'draft' ? 1 : null,
					createdBy: userId
				})
				.returning({ id: builds.id })
		);

		// Everything below hangs off the new build id and is independent, so the reads go out together,
		// then the inserts (multi-row, one statement per table) go out together in the same order as
		// before: filaments, parts, plates. The creation activity row comes last, after the saved parts.
		const [roleRows, partRows, tplPlates] = await Promise.all([
			tx.select().from(templateFilamentRoles).where(eq(templateFilamentRoles.templateId, tpl.id)),
			// Rows for every part, active or not, so switching variants keeps any progress.
			tx
				.select({ slug: templateParts.slug })
				.from(templateParts)
				.where(eq(templateParts.templateId, tpl.id)),
			layout
				? Promise.resolve([])
				: tx.select().from(templatePlates).where(eq(templatePlates.templateId, tpl.id))
		]);
		const overrides = new Map((design?.roles ?? []).map((r) => [r.key, r]));
		const own = new Set(roleRows.map((r) => r.key));
		const filaments: (typeof buildFilaments.$inferInsert)[] = roleRows.map((r) => {
			const o = overrides.get(r.key);
			return {
				buildId: id,
				roleKey: r.key,
				name: o?.name ?? r.name,
				material: o?.material ?? r.material,
				hex: o?.hex ?? r.hex,
				spools: r.recommendedSpools
			};
		});
		// Colors a design added beyond the kit's own slots.
		for (const r of design?.roles ?? []) {
			if (own.has(r.key)) continue;
			filaments.push({
				buildId: id,
				roleKey: r.key,
				name: r.name,
				material: r.material,
				hex: r.hex,
				spools: 0
			});
		}
		const plates: (typeof buildPlates.$inferInsert)[] = layout
			? layout.plates.map((p) => ({
					buildId: id,
					number: p.number,
					name: p.name,
					estSeconds: p.estSeconds,
					runs: p.runs,
					perPartRuns: p.perPartRuns ?? false,
					parts: p.parts,
					source: `layout:${layout.key}`
				}))
			: tplPlates.map((p) => ({
					buildId: id,
					number: p.number,
					name: p.name,
					estSeconds: p.estSeconds,
					runs: p.runs,
					perPartRuns: p.perPartRuns,
					parts: p.parts
				}));
		await Promise.all([
			insertRows(filaments, (v) => tx.insert(buildFilaments).values(v)),
			insertRows(
				partRows.map((p) => ({ buildId: id, partSlug: p.slug })),
				(v) => tx.insert(buildParts).values(v)
			),
			insertRows(plates, (v) => tx.insert(buildPlates).values(v))
		]);
		// Saved custom parts marked "Include in new builds": only for tracked builds made through the setup
		// flow (not drafts, imports or moves; the demo's seeded sample build passes no `setup`, so it never
		// gets any). Each piece gets its own savepoint (a nested `tx.transaction`), so one that cannot be
		// added leaves no partial rows and never fails the build.
		if (input.setup && input.kind !== 'draft') {
			// Bounded work: the caps stop the loop, rows that cannot fit are skipped without loading the view,
			// and the view is reloaded only after a piece was written (a failed piece rolled back to its savepoint).
			let pieces = 0;
			let platesUsed = 0;
			let view: BuildView | null | undefined;
			for (const listed of await defaultLibraryRows(tx, input.organizationId)) {
				if (pieces >= MAX_CUSTOM_PIECES || platesUsed >= MAX_CUSTOM_PLATES) break;
				const n = (listed.plates ?? []).length;
				if (!n || platesUsed + n > MAX_CUSTOM_PLATES) continue;
				// Read again with a share lock: a saved part deleted since the list was read is skipped, and a
				// delete that comes in now waits for this build, so no piece links to a deleted row.
				const lib = await lockLibraryRow(tx, input.organizationId, listed.id);
				if (!lib) continue;
				try {
					view ??= await loadBuildView(tx, id, userId);
					if (!view) break;
					const current = view;
					const made = await tx.transaction((sp) => applyLibraryPieceTx(sp, current, lib, userId));
					if (!made) continue;
					pieces++;
					platesUsed += n;
					view = undefined;
					await tx.insert(activity).values({
						buildId: id,
						userId,
						kind: 'custom.add',
						payload: {
							pieceId: made.pieceId,
							name: lib.name,
							fileName: lib.fileName,
							plates: [],
							sliced: lib.sliced,
							replaced: made.skippedNames,
							fromLibrary: true
						}
					});
				} catch (e) {
					// an unusable saved part is left out; anything unexpected still fails the build
					if (!(e instanceof ApiError)) throw e;
				}
			}
		}
		await tx.insert(activity).values({
			buildId: id,
			userId,
			kind: 'build.create',
			payload: input.kind === 'draft' ? { name, draft: true } : { name }
		});
		return id;
	});
	// A printer without an explicit layout: plan the plates for it right away.
	if (input.printer && !input.plateLayout) await arrangeForPrinter(db, newId, userId);
	return newId;
}
