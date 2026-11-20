import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import { ApiError, normalizeRole, requireNotDemo } from '#lib/server/access.ts';
import { getAuth } from '#lib/server/auth-instance.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { invitation, member, organization, user } from '#lib/server/db/schema.ts';
import { isPersonalMetadata } from '#lib/server/teams.ts';
import {
	changeMemberRole,
	deleteTeam,
	leaveTeam,
	otherMembers,
	removeTeamMember,
	teamDeletionSummary
} from '#lib/server/team-exit.ts';
import { teamMessage } from '#lib/team-wording.ts';
import type { Actions, PageServerLoad } from './$types';

async function teamFor(slug: string, userId: string) {
	const db = getDb();
	const org = await first(db.select().from(organization).where(eq(organization.slug, slug)));
	if (!org) error(404, 'Not found');
	const m = await first(
		db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, org.id), eq(member.userId, userId)))
	);
	if (!m) error(404, 'Not found');
	return { org, role: normalizeRole(m.role) };
}

export const load: PageServerLoad = async ({ params, locals }) => {
	// Signed out (e.g. the reload right after sign-out): same as the (app) layout.
	if (!locals.user) redirect(303, '/login');
	const { org, role } = await teamFor(params.slug, locals.user.id);
	// A personal workspace has no members to manage.
	if (isPersonalMetadata(org.metadata)) redirect(303, `/teams/${org.slug}`);
	const db = getDb();
	const members = (
		await db
			.select({
				id: member.id,
				userId: member.userId,
				name: user.name,
				email: user.email,
				role: member.role
			})
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(member.organizationId, org.id))
			.orderBy(asc(member.createdAt), asc(member.id))
	).map((m) => ({ ...m, role: normalizeRole(m.role) }));

	const invites =
		role === 'owner'
			? (
					await db
						.select({
							id: invitation.id,
							email: invitation.email,
							role: invitation.role,
							expiresAt: invitation.expiresAt
						})
						.from(invitation)
						.where(and(eq(invitation.organizationId, org.id), eq(invitation.status, 'pending')))
				).map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))
			: [];

	// Leaving: the sole owner of a team with other members must hand over first (picker).
	const soleOwner =
		role === 'owner' && !members.some((m) => m.userId !== locals.user!.id && m.role === 'owner');
	const heirs =
		soleOwner && members.length > 1
			? (await otherMembers(db, org.id, locals.user.id)).map((m) => ({
					userId: m.userId,
					name: m.name,
					email: m.email,
					role: m.role
				}))
			: [];
	return {
		members,
		invites,
		me: { userId: locals.user.id },
		leave: { onlyMember: members.length <= 1, needsHeir: soleOwner && members.length > 1, heirs },
		deletion: role === 'owner' ? await teamDeletionSummary(db, org.id, locals.user.id) : null
	};
};

function authFail(e: unknown) {
	const msg = e instanceof APIError || e instanceof Error ? e.message : '';
	return fail(400, { error: teamMessage(msg) });
}

/** A refusal from the role/remove helpers keeps its status; anything else is logged and generic. */
function memberFail(e: unknown) {
	if (e instanceof ApiError) return fail(e.status, { error: teamMessage(e.message) });
	console.error('[tmt] team member change failed', e);
	return fail(500, { error: 'Something went wrong. Nothing was changed.' });
}

/** A refusal from the leave/delete helpers keeps its status; anything else is logged and generic. */
function exitFail(e: unknown, what: 'leave' | 'delete') {
	if (e instanceof ApiError) return fail(e.status, { exitError: teamMessage(e.message), what });
	console.error(`[tmt] team ${what} failed`, e);
	return fail(500, {
		exitError:
			what === 'leave'
				? 'Could not leave the team. Nothing was changed.'
				: 'Could not delete the team. Nothing was changed.',
		what
	});
}

export const actions: Actions = {
	invite: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		const { org, role } = await teamFor(params.slug, locals.user.id);
		if (role !== 'owner') return fail(403, { error: 'Only owners can invite' });
		if (isPersonalMetadata(org.metadata))
			return fail(400, { error: 'Create a team to invite people' });
		const f = await request.formData();
		const email = String(f.get('email') ?? '')
			.trim()
			.toLowerCase();
		const r = String(f.get('role') ?? 'viewer');
		if (!email || !['editor', 'viewer'].includes(r))
			return fail(400, { error: 'Email and role required' });
		try {
			const inv = await getAuth().api.createInvitation({
				body: { email, role: r as 'editor', organizationId: org.id },
				headers: request.headers
			});
			return { invited: { id: inv.id, email } };
		} catch (e) {
			return authFail(e);
		}
	},

	revoke: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		const { role } = await teamFor(params.slug, locals.user.id);
		if (role !== 'owner') return fail(403, { error: 'Only owners can do this' });
		const invitationId = String((await request.formData()).get('id') ?? '');
		try {
			await getAuth().api.cancelInvitation({ body: { invitationId }, headers: request.headers });
		} catch (e) {
			return authFail(e);
		}
	},

	setRole: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		try {
			requireNotDemo(locals.user as { id: string; isDemo?: boolean });
		} catch (e) {
			return memberFail(e);
		}
		const { org, role } = await teamFor(params.slug, locals.user.id);
		if (role !== 'owner') return fail(403, { error: 'Only owners can do this' });
		const f = await request.formData();
		const r = String(f.get('role') ?? '');
		if (!['owner', 'editor', 'viewer'].includes(r)) return fail(400, { error: 'Unknown role' });
		try {
			await changeMemberRole(getDb(), locals.user.id, org.id, String(f.get('memberId') ?? ''), r);
		} catch (e) {
			return memberFail(e);
		}
	},

	remove: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		try {
			requireNotDemo(locals.user as { id: string; isDemo?: boolean });
		} catch (e) {
			return memberFail(e);
		}
		const { org, role } = await teamFor(params.slug, locals.user.id);
		if (role !== 'owner') return fail(403, { error: 'Only owners can do this' });
		const memberId = String((await request.formData()).get('memberId') ?? '');
		try {
			// Refuses your own row (400): leaving has its own flow.
			await removeTeamMember(getDb(), locals.user.id, org.id, memberId);
		} catch (e) {
			return memberFail(e);
		}
	},

	/** Any member leaves (the sole owner names who takes over). Demo users have no teams. */
	leave: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		try {
			requireNotDemo(locals.user as { id: string; isDemo?: boolean });
		} catch (e) {
			return exitFail(e, 'leave');
		}
		const { org } = await teamFor(params.slug, locals.user.id);
		const heir = String((await request.formData()).get('heir') ?? '') || null;
		try {
			await leaveTeam(getDb(), locals.user.id, org.id, heir);
		} catch (e) {
			return exitFail(e, 'leave');
		}
		redirect(303, '/workspace?notice=left');
	},

	/** Owners only, with the team name typed; the helper checks both again inside its transaction. */
	deleteTeam: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to continue' });
		try {
			requireNotDemo(locals.user as { id: string; isDemo?: boolean });
		} catch (e) {
			return exitFail(e, 'delete');
		}
		const { org, role } = await teamFor(params.slug, locals.user.id);
		if (role !== 'owner')
			return exitFail(new ApiError(403, 'Only team owners can delete the team.'), 'delete');
		const typed = String((await request.formData()).get('name') ?? '');
		try {
			await deleteTeam(getDb(), locals.user.id, org.id, typed);
		} catch (e) {
			return exitFail(e, 'delete');
		}
		redirect(303, '/workspace?notice=deleted');
	}
};
