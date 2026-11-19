import { and, eq, sql } from 'drizzle-orm';
import { first, one, type Db, type Tx } from '../db';
import {
	colorDesigns,
	templateAssemblySteps,
	templateFilamentRoles,
	templateGuidePages,
	templateHardware,
	templatePartPlacements,
	templateParts,
	templatePlateLayouts,
	templatePlates,
	templatePrintGeometry,
	templates
} from '../db/schema';
import { seedToFootprint } from '#lib/domain/print-footprint.ts';
import type { PlacementSeed, TemplateSeed } from './types';

/** `template_print_geometry.source_note` of rows that come from the seed (no mesh). */
export const SEED_NOTE = 'seed';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A database placement follows the seed only when no admin has edited it (`updatedBy` is null)
 * and its numbers differ from the seed's.
 */
export function shouldUpdatePlacement(
	cur: { matrix: number[]; instances: number[][]; placed: boolean; updatedBy: string | null },
	seed: PlacementSeed
): boolean {
	if (cur.updatedBy !== null) return false;
	const matrix = seed.matrix ?? IDENTITY;
	const instances = seed.instances ?? [];
	return (
		cur.placed !== seed.placed ||
		!sameNumbers(cur.matrix, matrix) ||
		cur.instances.length !== instances.length ||
		cur.instances.some((m, i) => !sameNumbers(m, instances[i]))
	);
}

const sameNumbers = (a: number[], b: number[]) =>
	a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

const SEED_LOCK_KEY = 7_346_201_002;

export interface SeedResult {
	/** Slugs of templates created from scratch. */
	inserted: string[];
	/** Slugs of existing templates that gained or changed something. */
	updated: string[];
}

/**
 * Brings the database in line with the seeds. Idempotent; one transaction per template.
 *
 * - New template: inserted whole.
 * - Existing template (matched by slug): reconciled. Missing parts, plates, filament
 *   roles, guide pages, hardware, designs and placements are inserted; static fields
 *   of parts, plates, roles and the template row (name, version, sections, variant
 *   groups, ...) are updated to the seed's values. Nothing is ever deleted, builds are
 *   never touched (existing builds get their new `build_parts` rows from
 *   `backfillBuildParts`), and a placement is updated from the seed only while no admin has
 *   edited it (`updated_by IS NULL`); admin edits are never overwritten.
 */
export async function seedTemplates(db: Db, seeds: TemplateSeed[]): Promise<SeedResult> {
	const inserted: string[] = [];
	const updated: string[] = [];
	for (const s of seeds) {
		// Per-template transaction behind an advisory lock: two containers starting together
		// reconcile one after the other instead of both inserting the same slug.
		const { existed, changed } = await db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
			const existing = await first(
				tx.select({ id: templates.id }).from(templates).where(eq(templates.slug, s.slug))
			);
			return {
				existed: !!existing,
				changed: await reconcileTemplate(tx, s, existing?.id ?? null)
			};
		});
		if (!existed) inserted.push(s.slug);
		else if (changed) updated.push(s.slug);
	}
	return { inserted, updated };
}

async function reconcileTemplate(
	tx: Tx,
	s: TemplateSeed,
	existingId: string | null
): Promise<boolean> {
	let changed = false;
	const row = {
		name: s.name,
		version: s.version,
		description: s.description,
		sourceUrl: s.sourceUrl ?? null,
		globalSettings: s.globalSettings,
		sections: s.sections,
		variantGroups: s.variantGroups ?? []
	};
	let templateId: string;
	if (existingId) {
		templateId = existingId;
		const cur = await one(
			tx.select().from(templates).where(eq(templates.id, templateId)),
			'template'
		);
		if (canon(pick(cur, row)) !== canon(row)) {
			await tx.update(templates).set(row).where(eq(templates.id, templateId));
			changed = true;
		}
	} else {
		templateId = (
			await one(
				tx
					.insert(templates)
					.values({ slug: s.slug, ...row })
					.returning({ id: templates.id }),
				'inserted template'
			)
		).id;
	}

	// Filament roles
	const roles = new Map(
		(
			await tx
				.select()
				.from(templateFilamentRoles)
				.where(eq(templateFilamentRoles.templateId, templateId))
		).map((r) => [r.key, r])
	);
	for (const r of s.filamentRoles) {
		const cur = roles.get(r.key);
		if (!cur) {
			await tx.insert(templateFilamentRoles).values({ templateId, ...r });
			changed = true;
		} else if (canon(pick(cur, r)) !== canon(r)) {
			await tx
				.update(templateFilamentRoles)
				.set(r)
				.where(
					and(
						eq(templateFilamentRoles.templateId, templateId),
						eq(templateFilamentRoles.key, r.key)
					)
				);
			changed = true;
		}
	}

	// Parts
	const parts = new Map(
		(await tx.select().from(templateParts).where(eq(templateParts.templateId, templateId))).map(
			(p) => [p.slug, p]
		)
	);
	for (const [i, p] of s.parts.entries()) {
		const values = {
			name: p.name,
			section: p.section,
			defaultRole: p.defaultRole,
			bomGrams: p.bomGrams,
			qty: p.qty,
			walls: p.walls,
			infill: p.infill,
			supports: p.supports,
			brim: p.brim ?? null,
			sourceFile: p.sourceFile,
			notes: p.notes,
			components: p.components ?? [],
			allowedMaterials: p.allowedMaterials,
			symmetryGroup: p.symmetryGroup ?? null,
			guideRefs: p.guideRefs,
			sort: i
		};
		const cur = parts.get(p.slug);
		if (!cur) {
			await tx.insert(templateParts).values({ templateId, slug: p.slug, ...values });
			changed = true;
		} else if (canon(pick(cur, values)) !== canon(values)) {
			await tx
				.update(templateParts)
				.set(values)
				.where(and(eq(templateParts.templateId, templateId), eq(templateParts.slug, p.slug)));
			changed = true;
		}
	}

	// Plates
	const plates = new Map(
		(await tx.select().from(templatePlates).where(eq(templatePlates.templateId, templateId))).map(
			(p) => [p.number, p]
		)
	);
	for (const p of s.plates) {
		const values = {
			name: p.name,
			estSeconds: p.estSeconds,
			runs: p.runs,
			runNote: p.runNote ?? null,
			perPartRuns: p.perPartRuns ?? false,
			parts: p.parts
		};
		const cur = plates.get(p.number);
		if (!cur) {
			await tx.insert(templatePlates).values({ templateId, number: p.number, ...values });
			changed = true;
		} else if (canon(pick(cur, values)) !== canon(values)) {
			await tx
				.update(templatePlates)
				.set(values)
				.where(and(eq(templatePlates.templateId, templateId), eq(templatePlates.number, p.number)));
			changed = true;
		}
	}

	// Plate layouts (insert missing, update static fields)
	const layouts = new Map(
		(
			await tx
				.select()
				.from(templatePlateLayouts)
				.where(eq(templatePlateLayouts.templateId, templateId))
		).map((l) => [l.key, l])
	);
	for (const [i, l] of (s.plateLayouts ?? []).entries()) {
		const values = {
			name: l.name,
			printerNote: l.printerNote,
			isDefault: l.isDefault ?? false,
			plates: l.plates.map((p) => ({
				number: p.number,
				name: p.name,
				estSeconds: p.estSeconds,
				runs: p.runs,
				...(p.runNote ? { runNote: p.runNote } : {}),
				...(p.perPartRuns ? { perPartRuns: true } : {}),
				parts: p.parts
			})),
			sort: i
		};
		const cur = layouts.get(l.key);
		if (!cur) {
			await tx.insert(templatePlateLayouts).values({ templateId, key: l.key, ...values });
			changed = true;
		} else if (canon(pick(cur, values)) !== canon(values)) {
			await tx
				.update(templatePlateLayouts)
				.set(values)
				.where(
					and(eq(templatePlateLayouts.templateId, templateId), eq(templatePlateLayouts.key, l.key))
				);
			changed = true;
		}
	}

	// Guide pages (insert missing, update titles)
	const pages = new Map(
		(
			await tx
				.select()
				.from(templateGuidePages)
				.where(eq(templateGuidePages.templateId, templateId))
		).map((g) => [g.page, g])
	);
	for (const g of s.guidePages) {
		const cur = pages.get(g.page);
		if (!cur) {
			await tx.insert(templateGuidePages).values({ templateId, ...g });
			changed = true;
		} else if (cur.title !== g.title || cur.sort !== g.sort) {
			await tx
				.update(templateGuidePages)
				.set({ title: g.title, sort: g.sort })
				.where(
					and(eq(templateGuidePages.templateId, templateId), eq(templateGuidePages.page, g.page))
				);
			changed = true;
		}
	}

	// Hardware (insert missing only)
	const hw = new Set(
		(
			await tx
				.select({ name: templateHardware.name })
				.from(templateHardware)
				.where(eq(templateHardware.templateId, templateId))
		).map((h) => h.name)
	);
	for (const h of s.hardware) {
		if (hw.has(h.name)) continue;
		await tx
			.insert(templateHardware)
			.values({ templateId, name: h.name, qty: h.qty ?? null, note: h.note ?? null });
		changed = true;
	}

	// Assembly steps (insert missing, update static fields; never deleted)
	const steps = new Map(
		(
			await tx
				.select()
				.from(templateAssemblySteps)
				.where(eq(templateAssemblySteps.templateId, templateId))
		).map((a) => [a.key, a])
	);
	for (const [i, a] of (s.assemblySteps ?? []).entries()) {
		const values = {
			sort: i,
			title: a.title,
			description: a.description,
			guidePage: a.guidePage ?? null,
			parts: a.parts ?? [],
			hardware: a.hardware ?? [],
			checks: a.checks ?? [],
			when: a.when ?? null
		};
		const cur = steps.get(a.key);
		if (!cur) {
			await tx.insert(templateAssemblySteps).values({ templateId, key: a.key, ...values });
			changed = true;
		} else if (canon(pick(cur, values)) !== canon(values)) {
			await tx
				.update(templateAssemblySteps)
				.set(values)
				.where(
					and(
						eq(templateAssemblySteps.templateId, templateId),
						eq(templateAssemblySteps.key, a.key)
					)
				);
			changed = true;
		}
	}

	// Color designs (insert missing only; designs may be edited by users later)
	const designs = new Set(
		(
			await tx
				.select({ slug: colorDesigns.slug })
				.from(colorDesigns)
				.where(eq(colorDesigns.templateId, templateId))
		).map((d) => d.slug)
	);
	for (const d of s.designs) {
		if (designs.has(d.slug)) continue;
		await tx.insert(colorDesigns).values({
			templateId,
			slug: d.slug,
			name: d.name,
			roles: d.roles,
			partRoles: d.partRoles,
			isPublic: true
		});
		changed = true;
	}

	// Placements: insert missing rows; update a row from the seed only while no admin has edited it
	// (`updated_by IS NULL`) and it differs. Admin edits are never overwritten. Parts the seed does
	// not mention get an unplaced identity row so every part has one.
	const existingPlacements = new Map(
		(
			await tx
				.select()
				.from(templatePartPlacements)
				.where(eq(templatePartPlacements.templateId, templateId))
		).map((p) => [p.slug, p])
	);
	const placements = new Map((s.placements ?? []).map((p) => [p.slug, p]));
	if (s.placements) {
		for (const part of s.parts) {
			const cur = existingPlacements.get(part.slug);
			if (cur) {
				const p = placements.get(part.slug);
				if (p && shouldUpdatePlacement(cur, p)) {
					await tx
						.update(templatePartPlacements)
						.set({
							matrix: p.matrix ?? IDENTITY,
							instances: p.instances ?? [],
							placed: p.placed,
							updatedAt: new Date()
						})
						.where(
							and(
								eq(templatePartPlacements.templateId, templateId),
								eq(templatePartPlacements.slug, part.slug)
							)
						);
					changed = true;
				}
				continue;
			}
			const p = placements.get(part.slug);
			await tx.insert(templatePartPlacements).values({
				templateId,
				slug: part.slug,
				matrix: p?.matrix ?? IDENTITY,
				instances: p?.instances ?? [],
				placed: p?.placed ?? false
			});
			changed = true;
		}
	}
	// Print footprints: insert missing; update rows that still hold seed values (imported geometry wins).
	for (const f of s.printFootprints ?? []) {
		const fp = seedToFootprint(f);
		if (!fp.pieces.length || !s.parts.some((p) => p.slug === f.slug)) continue;
		const cur = await first(
			tx
				.select({
					note: templatePrintGeometry.sourceNote,
					footprint: templatePrintGeometry.footprint
				})
				.from(templatePrintGeometry)
				.where(
					and(
						eq(templatePrintGeometry.templateId, templateId),
						eq(templatePrintGeometry.slug, f.slug)
					)
				)
		);
		const big = fp.pieces.reduce((a, b) => (b.w * b.d > a.w * a.d ? b : a));
		const row = {
			footprint: fp as unknown as Record<string, unknown>,
			hull: (fp.pieces[0]?.hull ?? []) as [number, number][],
			height: big.h,
			tris: 0,
			settings: {},
			meshPath: '',
			sourceNote: SEED_NOTE,
			updatedAt: new Date()
		};
		if (!cur) {
			await tx.insert(templatePrintGeometry).values({ templateId, slug: f.slug, ...row });
			changed = true;
		} else if (cur.note === SEED_NOTE && canon(cur.footprint) !== canon(fp)) {
			await tx
				.update(templatePrintGeometry)
				.set(row)
				.where(
					and(
						eq(templatePrintGeometry.templateId, templateId),
						eq(templatePrintGeometry.slug, f.slug)
					)
				);
			changed = true;
		}
	}
	return changed;
}

/** The subset of `cur` with the keys of `want`, in `want`'s key order, for comparison. */
function pick(cur: object, want: object): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(want)) out[k] = (cur as Record<string, unknown>)[k];
	return out;
}

/** Stable JSON (object keys sorted): Postgres jsonb returns keys in its own order. */
function canon(v: unknown): string {
	return JSON.stringify(v, (_k, val) =>
		val && typeof val === 'object' && !Array.isArray(val)
			? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: val
	);
}
