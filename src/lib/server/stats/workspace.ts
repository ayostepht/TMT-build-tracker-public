import { and, asc, eq } from 'drizzle-orm';
import {
	buildStatsSummary,
	clampMonths,
	workspaceStats,
	type WorkspaceStats
} from '#lib/domain/stats.ts';
import { requireMember } from '../access';
import type { Db } from '../db';
import { builds } from '../db/schema';
import { loadBuildView } from '../builds/view';

/**
 * Stats for a team or personal workspace (both are organizations), for a member of it. Every
 * member role (owner, editor, viewer) sees the whole workspace; anyone else gets a 404
 * (`ApiError`), like the build pages. Studio drafts are not builds and are left out. Each build is
 * loaded like its own page and reduced to a summary with no personal data (`buildStatsSummary`);
 * only the aggregate leaves here. `months` is clamped to 1-24 (default 6). Not cached.
 */
export async function loadWorkspaceStats(
	db: Db,
	orgId: string,
	userId: string,
	opts: { months?: unknown; now?: Date } = {}
): Promise<WorkspaceStats> {
	await requireMember(db, orgId, userId);
	const ids = await db
		.select({ id: builds.id })
		.from(builds)
		.where(and(eq(builds.organizationId, orgId), eq(builds.kind, 'build')))
		.orderBy(asc(builds.createdAt));
	const summaries = [];
	for (const { id } of ids) {
		const view = await loadBuildView(db, id, userId);
		if (view) summaries.push(buildStatsSummary(view));
	}
	return workspaceStats(summaries, { months: clampMonths(opts.months), now: opts.now });
}
