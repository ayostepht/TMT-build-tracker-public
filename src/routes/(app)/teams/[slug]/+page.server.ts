import { and, eq, inArray } from 'drizzle-orm';
import { buildRows, recentBuilds } from '#lib/server/builds/list.ts';
import { loadBuildView } from '#lib/server/builds/view.ts';
import { getDb } from '#lib/server/db/index.ts';
import { buildParts, builds } from '#lib/server/db/schema.ts';
import type { BuildView } from '#lib/domain/types.ts';
import type { PageServerLoad } from './$types';

/**
 * Most builds the landing shows controls for. All of a chapter's builds share one printer stream
 * (the nav uses the same one), so streams do not grow with this number. What does: each build is
 * re-fetched every 20 s and fetches its printer jobs every 30 s, so the cap stays modest. "All
 * builds" has the rest.
 */
const LANDING_BUILD_CAP = 6;

export const load: PageServerLoad = async ({ parent, locals }) => {
	const { team } = await parent();
	const db = getDb();
	const rows = await buildRows(db, [team.id]);
	if (!locals.user || !rows.length) return { builds: rows, landing: { views: [], more: 0 } };

	// Builds with a part on a printer always come first, then the most recently active unfinished
	// ones. `loadBuildView` applies the same member check as the build page itself. The two reads
	// do not depend on each other, so they run together (each query is a round trip to the database).
	const [printing, recent] = await Promise.all([
		db
			.select({ id: buildParts.buildId })
			.from(buildParts)
			.innerJoin(builds, eq(builds.id, buildParts.buildId))
			.where(
				and(
					eq(builds.organizationId, team.id),
					eq(builds.kind, 'build'),
					eq(buildParts.status, 'Printing'),
					inArray(
						builds.id,
						rows.map((r) => r.id)
					)
				)
			),
		recentBuilds(db, [team.id], rows.length)
	]);
	const printingIds = new Set(printing.map((r) => r.id));
	const candidates = recent.filter(
		(b) => printingIds.has(b.id) || (b.setupStep === null && b.total > 0 && b.printed < b.total)
	);
	const ordered = [
		...candidates.filter((b) => printingIds.has(b.id)),
		...candidates.filter((b) => !printingIds.has(b.id))
	];
	const userId = locals.user.id;
	// Side by side, in the same order as `ordered`.
	const loaded = await Promise.all(
		ordered.slice(0, LANDING_BUILD_CAP).map((b) => loadBuildView(db, b.id, userId))
	);
	const views = loaded.filter((v): v is BuildView => !!v);
	return { builds: rows, landing: { views, more: Math.max(0, ordered.length - views.length) } };
};
