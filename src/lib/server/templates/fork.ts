import { and, asc, count, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import {
	ApiError,
	canEditRole,
	getMemberRole,
	isSiteAdmin,
	requireEditor,
	type SiteAdminCandidate
} from '../access';
import { advisoryLock, first, one, type DbOrTx } from '../db';
import { canSeeDesign } from '../designs/access';
import { assertUnder, quotaLimit } from '../quota';
import {
	builds,
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

/** `template_print_geometry.source_note` of rows that carry seed footprints only (no mesh file). */
const SEED_NOTE = 'seed';

/** Templates a workspace can start a build from: every global one plus the workspace's own copies. */
export async function listTemplatesFor(db: DbOrTx, orgId: string) {
	return db
		.select()
		.from(templates)
		.where(or(isNull(templates.ownerOrgId), eq(templates.ownerOrgId, orgId)))
		.orderBy(asc(templates.createdAt), asc(templates.name));
}

/** Kit copies (templates with an owner) a workspace holds, used or not: they all hold disk. */
export async function countKitCopies(db: DbOrTx, orgId: string): Promise<number> {
	return (
		(await first(db.select({ n: count() }).from(templates).where(eq(templates.ownerOrgId, orgId))))
			?.n ?? 0
	);
}

/**
 * May this user read the template (model, layouts, kit status, ...)? Built-in kits: everyone.
 * A workspace's copy: members of that workspace, site admins, and anyone who can see a color
 * design made on it (shared gallery designs show the copy's model).
 */
export async function canViewTemplate(
	db: DbOrTx,
	user: SiteAdminCandidate,
	templateId: string
): Promise<boolean> {
	const t = await first(
		db
			.select({ ownerOrgId: templates.ownerOrgId })
			.from(templates)
			.where(eq(templates.id, templateId))
	);
	if (!t) return false;
	if (!t.ownerOrgId) return true;
	if (await getMemberRole(db, t.ownerOrgId, user.id)) return true;
	if (await isSiteAdmin(db, user)) return true;
	const designs = await db
		.select()
		.from(colorDesigns)
		.where(eq(colorDesigns.templateId, templateId));
	for (const d of designs) if (await canSeeDesign(db, d, user.id)) return true;
	return false;
}

/** 404 (never 403: does not reveal the copy exists) unless `canViewTemplate`. */
export async function assertTemplateViewable(
	db: DbOrTx,
	user: SiteAdminCandidate,
	templateId: string
): Promise<void> {
	if (!(await canViewTemplate(db, user, templateId))) throw new ApiError(404, 'Not found');
}

/** The template a new build starts on: the oldest global one (the built-in MakeGood kit). */
export async function defaultTemplate(db: DbOrTx) {
	const t = await first(
		db
			.select()
			.from(templates)
			.where(isNull(templates.ownerOrgId))
			.orderBy(asc(templates.createdAt), asc(templates.name))
			.limit(1)
	);
	if (!t) throw new ApiError(500, 'No template is installed');
	return t;
}

/**
 * May this user add or replace kit files of the template? Global templates: site admins only
 * (imports are install-wide). A workspace's own template: owners and editors of that workspace.
 */
export async function canManageTemplate(
	db: DbOrTx,
	user: SiteAdminCandidate,
	templateId: string
): Promise<boolean> {
	const t = await first(
		db
			.select({ ownerOrgId: templates.ownerOrgId })
			.from(templates)
			.where(eq(templates.id, templateId))
	);
	if (!t) return false;
	if (!t.ownerOrgId) return await isSiteAdmin(db, user);
	const role = await getMemberRole(db, t.ownerOrgId, user.id);
	return !!role && canEditRole(role);
}

async function uniqueSlug(db: DbOrTx, base: string): Promise<string> {
	let slug = base;
	while (
		await first(db.select({ id: templates.id }).from(templates).where(eq(templates.slug, slug)))
	)
		slug = `${base.slice(0, 50)}-${crypto.randomUUID().slice(0, 4)}`;
	return slug;
}

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 30) || 'kit'
	);
}

/**
 * Copies a template's static data (filament roles, parts, plates, plate layouts, guide page titles,
 * hardware, assembly steps, placements, seed print footprints) into a new template owned by the
 * workspace. Builds, color designs, the 3D model and imported print geometry are not copied: the
 * workspace adds its own files to the copy. Returns the new template id.
 */
export async function forkTemplate(
	db: DbOrTx,
	orgId: string,
	baseTemplateId: string,
	name: string,
	userId = ''
): Promise<string> {
	const title = name.trim().slice(0, 120);
	if (!title) throw new ApiError(400, 'Name is required');
	return await db.transaction(async (tx) => {
		// Count and insert in this one transaction under a per-workspace lock, so two requests
		// cannot both pass the limit.
		await advisoryLock(tx, `quota:kitCopies:${orgId}`);
		await assertUnder(tx, 'kitCopiesPerWorkspace', () => countKitCopies(tx, orgId), {
			userId,
			scope: orgId
		});
		const base = await first(tx.select().from(templates).where(eq(templates.id, baseTemplateId)));
		if (!base) throw new ApiError(404, 'Template not found');
		// Fork the original kit, not a fork of it.
		const rootId = base.baseTemplateId ?? base.id;
		const { id } = await one(
			tx
				.insert(templates)
				.values({
					slug: await uniqueSlug(tx, `${slugify(title)}-${orgId.slice(0, 6)}`),
					name: title,
					version: base.version,
					description: base.description,
					sourceUrl: base.sourceUrl,
					globalSettings: base.globalSettings,
					sections: base.sections,
					variantGroups: base.variantGroups,
					ownerOrgId: orgId,
					baseTemplateId: rootId
				})
				.returning({ id: templates.id })
		);

		const re = <T extends { templateId: string }>(rows: T[]) =>
			rows.map((r) => ({ ...r, templateId: id }));

		const roles = await tx
			.select()
			.from(templateFilamentRoles)
			.where(eq(templateFilamentRoles.templateId, baseTemplateId));
		if (roles.length) await tx.insert(templateFilamentRoles).values(re(roles));
		const parts = await tx
			.select()
			.from(templateParts)
			.where(eq(templateParts.templateId, baseTemplateId));
		if (parts.length) await tx.insert(templateParts).values(re(parts));
		const plates = await tx
			.select()
			.from(templatePlates)
			.where(eq(templatePlates.templateId, baseTemplateId));
		if (plates.length) await tx.insert(templatePlates).values(re(plates));
		const guide = await tx
			.select()
			.from(templateGuidePages)
			.where(eq(templateGuidePages.templateId, baseTemplateId));
		if (guide.length)
			await tx.insert(templateGuidePages).values(re(guide).map((g) => ({ ...g, imagePath: null })));
		const hardware = await tx
			.select()
			.from(templateHardware)
			.where(eq(templateHardware.templateId, baseTemplateId));
		if (hardware.length) await tx.insert(templateHardware).values(re(hardware));
		const steps = await tx
			.select()
			.from(templateAssemblySteps)
			.where(eq(templateAssemblySteps.templateId, baseTemplateId));
		if (steps.length) await tx.insert(templateAssemblySteps).values(re(steps));
		const layouts = await tx
			.select()
			.from(templatePlateLayouts)
			.where(eq(templatePlateLayouts.templateId, baseTemplateId));
		if (layouts.length) await tx.insert(templatePlateLayouts).values(re(layouts));
		const placements = await tx
			.select()
			.from(templatePartPlacements)
			.where(eq(templatePartPlacements.templateId, baseTemplateId));
		if (placements.length) await tx.insert(templatePartPlacements).values(re(placements));
		const geometry = await tx
			.select()
			.from(templatePrintGeometry)
			.where(
				and(
					eq(templatePrintGeometry.templateId, baseTemplateId),
					eq(templatePrintGeometry.sourceNote, SEED_NOTE)
				)
			);
		if (geometry.length) await tx.insert(templatePrintGeometry).values(re(geometry));
		return id;
	});
}

/**
 * Setup wizard, step 1: point the build at the built-in kit (`own: false`) or at a workspace-owned
 * copy (`own: true`, created on first use and reused afterwards). Both share the same part slugs,
 * so the build's parts, plates and colors carry over unchanged.
 */
export async function chooseBuildTemplate(
	db: DbOrTx,
	buildId: string,
	userId: string,
	own: boolean
): Promise<{ templateId: string }> {
	const b = await first(db.select().from(builds).where(eq(builds.id, buildId)));
	if (!b) throw new ApiError(404, 'Not found');
	await requireEditor(db, b.organizationId, userId);
	const cur = await first(db.select().from(templates).where(eq(templates.id, b.templateId)));
	if (!cur) throw new ApiError(404, 'Not found');
	const rootId = cur.baseTemplateId ?? cur.id;
	let target: string;
	if (!own) target = rootId;
	else if (cur.ownerOrgId) target = cur.id;
	else {
		const title = `${b.name} chair`;
		const existing = await first(
			db
				.select({ id: templates.id })
				.from(templates)
				.where(
					and(
						eq(templates.ownerOrgId, b.organizationId),
						eq(templates.baseTemplateId, rootId),
						eq(templates.name, title)
					)
				)
				.orderBy(desc(templates.createdAt))
		);
		target =
			existing?.id ??
			(await db.transaction(async (tx) => {
				// Same lock as forkTemplate (re-entrant within this transaction): the limit check
				// and the copy happen under it.
				await advisoryLock(tx, `quota:kitCopies:${b.organizationId}`);
				// At the copies limit, reuse a copy no build uses (left by switching back to the
				// built-in kit) instead of refusing. Self-hosted (no limit) always makes a new one.
				const limit = quotaLimit('kitCopiesPerWorkspace');
				if (limit !== null && (await countKitCopies(tx, b.organizationId)) >= limit) {
					const unused = await first(
						tx
							.select({ id: templates.id })
							.from(templates)
							.where(
								and(
									eq(templates.ownerOrgId, b.organizationId),
									eq(templates.baseTemplateId, rootId),
									notInArray(templates.id, tx.select({ id: builds.templateId }).from(builds))
								)
							)
							.orderBy(desc(templates.createdAt))
					);
					if (unused) return unused.id;
				}
				return await forkTemplate(tx, b.organizationId, rootId, title, userId);
			}));
	}
	if (target !== b.templateId)
		await db.update(builds).set({ templateId: target }).where(eq(builds.id, buildId));
	return { templateId: target };
}
