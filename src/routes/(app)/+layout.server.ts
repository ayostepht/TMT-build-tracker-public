import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { buildAccess, isSiteAdmin } from '#lib/server/access.ts';
import { recentBuilds } from '#lib/server/builds/list.ts';
import { getAuth } from '#lib/server/auth-instance.ts';
import { mayUseInvitations } from '#lib/server/auth-policy.ts';
import { demoConfig } from '#lib/server/config.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { printerCounts } from '#lib/server/printers/store.ts';
import { builds } from '#lib/server/db/schema.ts';
import {
	ensurePersonalWorkspace,
	findPersonalWorkspace,
	listTeams,
	pendingInvitationCount
} from '#lib/server/teams.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, request }) => {
	if (!locals.user) {
		const back = url.pathname + url.search;
		redirect(303, `/login?redirect=${encodeURIComponent(back)}`);
	}
	const db = getDb();
	const user = locals.user;
	const isDemo = (user as { isDemo?: boolean }).isDemo === true;
	// Each query is a network round trip to the database, so what does not depend on another
	// result runs together: the layout is one wave of two queries, then one wave of the rest.
	const [personal, listed] = await Promise.all([
		findPersonalWorkspace(db, user.id),
		listTeams(db, user.id)
	]);
	// Users from before personal workspaces existed get theirs on first visit.
	let raw = listed;
	if (!personal) {
		await ensurePersonalWorkspace(db, { id: user.id, name: user.name });
		raw = await listTeams(db, user.id);
	}
	const activeId = (locals.session as { activeOrganizationId?: string | null } | null)
		?.activeOrganizationId;
	// Without a valid active workspace, prefer a real chapter (legacy users) over "My builds".
	const fallback = raw.find((t) => !t.personal) ?? raw[0];
	const activeTeamId = raw.find((t) => t.id === activeId)?.id ?? fallback?.id ?? null;
	// A personal workspace is shown as "My builds"; its stored name is only a fallback.
	const teams = raw.map((t) => (t.personal ? { ...t, name: 'My builds' } : t));
	const teamIds = teams.map((t) => t.id);
	// A page reached from a build (`?from=<buildId>`) offers a way back to it.
	const fromId = url.searchParams.get('from');
	const loadBackBuild = async (): Promise<{ id: string; name: string } | null> => {
		if (!fromId || !(await buildAccess(db, fromId, user.id))) return null;
		return (
			(await first(
				db.select({ id: builds.id, name: builds.name }).from(builds).where(eq(builds.id, fromId))
			)) ?? null
		);
	};
	const rememberActiveTeam = async () => {
		if (!activeTeamId || activeTeamId === activeId) return;
		try {
			await getAuth().api.setActiveOrganization({
				body: { organizationId: activeTeamId },
				headers: request.headers
			});
		} catch {
			/* non-fatal */
		}
	};
	const [counts, admin, invitations, recent, backBuild] = await Promise.all([
		// One query per workspace; side by side instead of one after the other.
		Promise.all(teamIds.map((id) => printerCounts(db, [id]))),
		isSiteAdmin(db, user),
		mayUseInvitations(user) ? pendingInvitationCount(db, user.email) : 0,
		recentBuilds(db, teamIds),
		loadBackBuild(),
		rememberActiveTeam()
	]);
	const nameOf = new Map(teams.map((t) => [t.id, t.name]));
	return {
		user: { id: user.id, name: user.name, email: user.email },
		teams,
		/** Printers per workspace: the nav's Printers link goes where the printers are. */
		printerCounts: Object.assign({}, ...counts) as Record<string, number>,
		activeTeamId,
		/** Install-wide admin (`ADMIN_EMAILS` or granted in the app): shows the "Kit admin" link. */
		siteAdmin: admin,
		/** Demo sandbox: the layout shows the banner (ends at `demoEndsAt`) and signing out deletes it. */
		isDemo,
		demoEndsAt: isDemo
			? new Date(new Date(user.createdAt).getTime() + demoConfig().ttlMs).toISOString()
			: null,
		invitationCount: invitations,
		/** Builds touched most recently across all workspaces, for the Builds menu. */
		recentBuilds: recent.map((b) => ({
			id: b.id,
			name: b.name,
			progress: b.progress,
			printed: b.printed,
			total: b.total,
			setupStep: b.setupStep,
			workspace: nameOf.get(b.organizationId) ?? ''
		})),
		backBuild
	};
};
