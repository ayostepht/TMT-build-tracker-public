import { fail, redirect } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { getAuth } from '#lib/server/auth-instance.ts';
import { mayUseInvitations } from '#lib/server/auth-policy.ts';
import { ApiError, requireNotDemo } from '#lib/server/access.ts';
import { getDb } from '#lib/server/db/index.ts';
import { invitation, organization, user } from '#lib/server/db/schema.ts';
import { createTeamWithSlug, listTeams } from '#lib/server/teams.ts';
import { teamMessage } from '#lib/team-wording.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	const email = locals.user.email.toLowerCase();
	// Only a provider-verified email (never the demo) may see or accept invitations.
	if (!mayUseInvitations(locals.user)) return { invitations: [] };
	const invitations = (
		await getDb()
			.select({
				id: invitation.id,
				role: invitation.role,
				email: invitation.email,
				team: organization.name,
				inviter: user.name
			})
			.from(invitation)
			.innerJoin(organization, eq(organization.id, invitation.organizationId))
			.innerJoin(user, eq(user.id, invitation.inviterId))
			.where(and(eq(invitation.status, 'pending'), gt(invitation.expiresAt, new Date())))
	).filter((i) => i.email.toLowerCase() === email);
	return { invitations };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		try {
			requireNotDemo(locals.user);
		} catch (e) {
			if (e instanceof ApiError) return fail(e.status, { error: e.message });
			throw e;
		}
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Give your team a name' });
		const db = getDb();
		// A second team with the same name is allowed, but only after a second press.
		if (
			String(f.get('confirm') ?? '')
				.trim()
				.toLowerCase() !== name.toLowerCase()
		) {
			const same = (await listTeams(db, locals.user.id)).some(
				(t) => !t.personal && t.name.trim().toLowerCase() === name.toLowerCase()
			);
			if (same) return fail(409, { duplicate: name });
		}
		let slug: string;
		try {
			slug = await createTeamWithSlug(db, name, (s) =>
				getAuth().api.createOrganization({ body: { name, slug: s }, headers: request.headers })
			);
		} catch (e) {
			return fail(400, { error: teamMessage((e as Error).message, 'Could not create team') });
		}
		redirect(303, `/teams/${slug}`);
	}
};
