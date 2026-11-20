import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import type { BuildKind } from '#lib/domain/types.ts';
import { inactiveSlugs } from '#lib/domain/variants.ts';
import type { DbOrTx } from '../db';
import {
	activity,
	buildFilaments,
	buildParts,
	builds,
	templateFilamentRoles,
	templates
} from '../db/schema';

export interface BuildRow {
	id: string;
	organizationId: string;
	name: string;
	phase: string;
	deliveryDate: string | null;
	setupStep: number | null;
	total: number;
	printed: number;
	progress: number;
	/** Creation time, ms. */
	created: number;
}

/**
 * Builds with printed/total counts that respect each build's variant choices. Studio drafts
 * (kind 'draft') are left out unless asked for: they are not builds and never count as progress.
 */
export async function buildRows(
	db: DbOrTx,
	orgIds: string[],
	kind: BuildKind = 'build'
): Promise<BuildRow[]> {
	if (!orgIds.length) return [];
	// Templates and the builds are independent; the parts of all the builds come in one query.
	const [templateRows, list] = await Promise.all([
		db.select({ id: templates.id, groups: templates.variantGroups }).from(templates),
		db
			.select({
				id: builds.id,
				organizationId: builds.organizationId,
				name: builds.name,
				phase: builds.phase,
				deliveryDate: builds.deliveryDate,
				setupStep: builds.setupStep,
				templateId: builds.templateId,
				createdAt: builds.createdAt,
				choices: builds.variantChoices
			})
			.from(builds)
			.where(and(inArray(builds.organizationId, orgIds), eq(builds.kind, kind)))
			.orderBy(desc(builds.createdAt), desc(builds.id))
	]);
	if (!list.length) return [];
	const groupsByTemplate = new Map(templateRows.map((t) => [t.id, t.groups]));
	const partsByBuild = new Map<string, { slug: string; status: string }[]>();
	for (const r of await db
		.select({ id: buildParts.buildId, slug: buildParts.partSlug, status: buildParts.status })
		.from(buildParts)
		.where(
			inArray(
				buildParts.buildId,
				list.map((b) => b.id)
			)
		)) {
		const rows = partsByBuild.get(r.id);
		if (rows) rows.push(r);
		else partsByBuild.set(r.id, [r]);
	}
	const out: BuildRow[] = [];
	for (const { templateId, choices, createdAt, ...b } of list) {
		const off = inactiveSlugs(groupsByTemplate.get(templateId) ?? [], choices);
		const rows = (partsByBuild.get(b.id) ?? []).filter((r) => !off.has(r.slug));
		const total = rows.length;
		const printed = rows.filter((r) => r.status === 'Printed').length;
		out.push({
			...b,
			created: createdAt.getTime(),
			total,
			printed,
			progress: total ? Math.round((printed / total) * 100) : 0
		});
	}
	return out;
}

/**
 * The builds touched most recently (last activity, else creation) across the given workspaces.
 * A caller that already holds `buildRows(db, orgIds)` passes it as `known` to skip loading it again.
 */
export async function recentBuilds(
	db: DbOrTx,
	orgIds: string[],
	limit = 6,
	known?: BuildRow[]
): Promise<BuildRow[]> {
	const rows = known ?? (await buildRows(db, orgIds));
	if (rows.length <= 1) return rows;
	const last = new Map(
		(
			await db
				.select({ id: activity.buildId, at: max(activity.at) })
				.from(activity)
				.where(
					inArray(
						activity.buildId,
						rows.map((r) => r.id)
					)
				)
				.groupBy(activity.buildId)
				.orderBy(desc(max(activity.at)))
		).map((r) => [r.id, r.at ? r.at.getTime() : 0])
	);
	// `rows` is newest-created first; a stable sort keeps that order for builds without activity.
	return [...rows]
		.sort((a, b) => (last.get(b.id) ?? b.created) - (last.get(a.id) ?? a.created))
		.slice(0, limit);
}

export interface DraftRow {
	id: string;
	organizationId: string;
	name: string;
	templateName: string;
	/** Hex colours of the draft's filament slots, in slot order. */
	colors: string[];
	/** Last change (activity, else creation), ms. */
	updated: number;
}

/** Studio drafts in the given workspaces, most recently changed first. */
export async function draftRows(db: DbOrTx, orgIds: string[]): Promise<DraftRow[]> {
	if (!orgIds.length) return [];
	const rows = await db
		.select({
			templateId: builds.templateId,
			id: builds.id,
			organizationId: builds.organizationId,
			name: builds.name,
			templateName: templates.name,
			createdAt: builds.createdAt,
			design: builds.design
		})
		.from(builds)
		.innerJoin(templates, eq(templates.id, builds.templateId))
		.where(and(inArray(builds.organizationId, orgIds), eq(builds.kind, 'draft')));
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const last = new Map(
		(
			await db
				.select({ id: activity.buildId, at: max(activity.at) })
				.from(activity)
				.where(inArray(activity.buildId, ids))
				.groupBy(activity.buildId)
		).map((r) => [r.id, r.at ? r.at.getTime() : 0])
	);
	const fils = await db
		.select({
			buildId: buildFilaments.buildId,
			hex: buildFilaments.hex,
			key: buildFilaments.roleKey
		})
		.from(buildFilaments)
		.where(inArray(buildFilaments.buildId, ids))
		.orderBy(asc(buildFilaments.roleKey));
	// Slot order: the kit's own roles in their template order, colors a design added after them.
	const roleOrder = new Map<string, string[]>();
	const roles = await db
		.select({ templateId: templateFilamentRoles.templateId, key: templateFilamentRoles.key })
		.from(templateFilamentRoles)
		.where(
			inArray(
				templateFilamentRoles.templateId,
				rows.map((r) => r.templateId)
			)
		)
		// SQLite returned these in primary-key (key) order; keep that slot order.
		.orderBy(asc(templateFilamentRoles.key));
	for (const t of roles)
		roleOrder.set(t.templateId, [...(roleOrder.get(t.templateId) ?? []), t.key]);
	const slotRank = (templateId: string, key: string) => {
		const order = roleOrder.get(templateId) ?? [];
		const i = order.indexOf(key);
		return i < 0 ? order.length : i;
	};
	return rows
		.map((r) => ({
			id: r.id,
			organizationId: r.organizationId,
			name: r.name,
			templateName: r.templateName,
			colors: fils
				.filter((f) => f.buildId === r.id)
				.sort((a, c) => slotRank(r.templateId, a.key) - slotRank(r.templateId, c.key))
				.map((f) => f.hex),
			updated: last.get(r.id) ?? r.createdAt.getTime()
		}))
		.sort((a, b) => b.updated - a.updated);
}
