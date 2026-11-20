import { error, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { normalizeRole } from '#lib/server/access.ts';
import { getAuth } from '#lib/server/auth-instance.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { member, organization } from '#lib/server/db/schema.ts';
import { isPersonalMetadata } from '#lib/server/teams.ts';
import type { LayoutServerLoad } from './$types';

/** Workspace header data shared by the chapter tabs (Builds, Members, Printers, Integrations). */
export const load: LayoutServerLoad = async ({ params, locals, request }) => {
	// Signed out (e.g. the reload right after sign-out): same as the (app) layout.
	if (!locals.user) redirect(303, '/login');
	const db = getDb();
	// One query for the team and the caller's membership (not a member: the same 404 as no team).
	const found = await first(
		db
			.select({ org: organization, role: member.role })
			.from(organization)
			.innerJoin(
				member,
				and(eq(member.organizationId, organization.id), eq(member.userId, locals.user.id))
			)
			.where(eq(organization.slug, params.slug))
	);
	if (!found) error(404, 'Not found');
	const { org } = found;
	const m = { role: found.role };
	const role = normalizeRole(m.role);

	const active = (locals.session as { activeOrganizationId?: string | null } | null)
		?.activeOrganizationId;
	if (active !== org.id) {
		try {
			await getAuth().api.setActiveOrganization({
				body: { organizationId: org.id },
				headers: request.headers
			});
		} catch {
			/* non-fatal */
		}
	}

	const personal = isPersonalMetadata(org.metadata);
	return {
		team: { id: org.id, name: personal ? 'My builds' : org.name, slug: org.slug, personal },
		role,
		canEdit: role !== 'viewer'
	};
};
