import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getAuth } from '#lib/server/auth-instance.ts';
import { mayUseInvitations } from '#lib/server/auth-policy.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { invitation, member, organization, user } from '#lib/server/db/schema.ts';
import { maskEmail, teamMessage } from '#lib/team-wording.ts';
import type { Actions, PageServerLoad } from './$types';

function policyAllows(u: { emailVerified?: boolean | null; isDemo?: boolean | null }) {
	return mayUseInvitations(u);
}

function find(id: string) {
	return first(
		getDb()
			.select({
				id: invitation.id,
				organizationId: invitation.organizationId,
				email: invitation.email,
				role: invitation.role,
				status: invitation.status,
				expiresAt: invitation.expiresAt,
				team: organization.name,
				slug: organization.slug,
				inviter: user.name
			})
			.from(invitation)
			.innerJoin(organization, eq(organization.id, invitation.organizationId))
			.innerJoin(user, eq(user.id, invitation.inviterId))
			.where(eq(invitation.id, id))
	);
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const inv = await find(params.id);
	if (!inv) error(404, 'Invitation not found');
	const status = inv.expiresAt < new Date() && inv.status === 'pending' ? 'expired' : inv.status;
	const wrongAccount = !!locals.user && locals.user.email.toLowerCase() !== inv.email.toLowerCase();
	const isMember = locals.user
		? !!(await first(
				getDb()
					.select({ id: member.id })
					.from(member)
					.where(
						and(eq(member.organizationId, inv.organizationId), eq(member.userId, locals.user.id))
					)
			))
		: false;
	return {
		invitation: {
			id: inv.id,
			team: inv.team,
			role: inv.role,
			inviter: inv.inviter,
			status,
			// The team's address is only for its members (the "Go to the team" link).
			slug: isMember ? inv.slug : null,
			// Only reveal the invited address to the person it was sent to.
			email:
				locals.user && locals.user.email.toLowerCase() === inv.email.toLowerCase()
					? inv.email
					: null,
			// A different signed-in account sees the first character and the domain, never more.
			maskedEmail: wrongAccount && status === 'pending' ? maskEmail(inv.email) : null
		},
		isMember,
		signedIn: !!locals.user,
		isDemo: (locals.user as { isDemo?: boolean } | null)?.isDemo === true,
		needsVerifiedEmail: !!locals.user && !policyAllows(locals.user),
		wrongAccount,
		userEmail: locals.user?.email ?? null
	};
};

export const actions: Actions = {
	accept: async ({ params, request, locals }) => {
		if (!locals.user) redirect(303, `/login?redirect=/invite/${params.id}`);
		const inv = await find(params.id);
		if (!inv) error(404, 'Invitation not found');
		if (!policyAllows(locals.user))
			return fail(403, {
				error: 'Sign in with a verified email address (not the demo) to accept an invitation'
			});
		try {
			await getAuth().api.acceptInvitation({
				body: { invitationId: params.id },
				headers: request.headers
			});
		} catch (e) {
			return fail(400, { error: teamMessage((e as Error).message, 'Could not accept invitation') });
		}
		redirect(303, `/teams/${inv.slug}`);
	},
	decline: async ({ params, request, locals }) => {
		if (!locals.user) redirect(303, `/login?redirect=/invite/${params.id}`);
		try {
			await getAuth().api.rejectInvitation({
				body: { invitationId: params.id },
				headers: request.headers
			});
		} catch (e) {
			return fail(400, {
				error: teamMessage((e as Error).message, 'Could not decline invitation')
			});
		}
		redirect(303, '/workspace');
	}
};
