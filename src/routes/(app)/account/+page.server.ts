import { fail, redirect } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { ApiError, isDemoUser, isSiteAdmin } from '#lib/server/access.ts';
import {
	AccountDeletionError,
	deleteAccount,
	planAccountDeletion,
	siteBlock
} from '#lib/server/account.ts';
import { grantSiteAdmin, listSiteAdmins, revokeSiteAdmin } from '#lib/server/site-admins.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { builds } from '#lib/server/db/schema.ts';
import type { Actions, PageServerLoad } from './$types';

/** Sign-in is SSO only (no password to type), so the session must be this young to delete an account. */
const FRESH_SESSION_MS = 10 * 60 * 1000;

const freshSession = (session: { createdAt: Date } | null) =>
	!!session && Date.now() - new Date(session.createdAt).getTime() < FRESH_SESSION_MS;

export const load: PageServerLoad = async ({ locals }) => {
	const u = locals.user!;
	// A demo has no account to manage: it ends on its own (the banner says when) or at sign-out.
	if (isDemoUser(u as { id: string; isDemo?: boolean })) redirect(303, '/workspace');
	const db = getDb();
	const fates = await planAccountDeletion(db, u.id);
	const personal = fates.find((f) => f.fate === 'personal');
	const personalBuilds = personal
		? ((
				await first(
					db.select({ n: count() }).from(builds).where(eq(builds.organizationId, personal.orgId))
				)
			)?.n ?? 0)
		: 0;
	const site = await siteBlock(db, u.id);
	const isAdmin = await isSiteAdmin(db, u);
	return {
		isAdmin,
		/** Site admins and where each role comes from; only site admins get the list. */
		siteAdmins: isAdmin ? await listSiteAdmins(db, u) : [],
		/** `last_admin`, `only_account` or null: refused for site-wide reasons. */
		siteBlock: site?.code ?? null,
		siteBlockMessage: site?.message ?? null,
		email: u.email,
		name: u.name,
		/** Accounts must have signed in within the last 10 minutes to delete themselves. */
		needsRecentSignIn: !freshSession(locals.session),
		personalBuilds,
		deletedChapters: fates.filter((f) => f.fate === 'delete').map((f) => f.name),
		leftChapters: fates.filter((f) => f.fate === 'leave').map((f) => f.name),
		blockedChapters: fates.filter((f) => f.fate === 'blocked').map((f) => f.name)
	};
};

export const actions: Actions = {
	grant: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const id = String((await request.formData()).get('userId') ?? '');
		try {
			await grantSiteAdmin(getDb(), locals.user, id);
		} catch (e) {
			if (e instanceof ApiError) return fail(e.status, { adminError: e.message });
			throw e;
		}
		return { granted: true };
	},
	revoke: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const id = String((await request.formData()).get('userId') ?? '');
		try {
			await revokeSiteAdmin(getDb(), locals.user, id);
		} catch (e) {
			if (e instanceof ApiError) return fail(e.status, { adminError: e.message });
			throw e;
		}
		return { revoked: true };
	},
	/**
	 * Self-service deletion. Needs the account's email typed exactly and a sign-in from the last
	 * 10 minutes (so a left-open browser cannot delete the account). A demo user has no account:
	 * its page and this action refuse, and it is deleted by signing out or by the cleanup job.
	 */
	delete: async ({ request, locals }) => {
		const u = locals.user;
		if (!u) redirect(303, '/login');
		if (isDemoUser(u as { id: string; isDemo?: boolean }))
			return fail(403, { error: 'The demo ends on its own. Sign out to delete it now.' });
		const f = await request.formData();
		const typed = String(f.get('email') ?? '')
			.trim()
			.toLowerCase();
		if (typed !== u.email.trim().toLowerCase())
			return fail(400, { error: 'Type your account email exactly as shown to confirm.' });
		if (!freshSession(locals.session))
			return fail(403, {
				error: 'For your safety, sign in again, then delete your account within 10 minutes.',
				signInAgain: true
			});

		try {
			await deleteAccount(getDb(), u.id);
		} catch (e) {
			if (e instanceof AccountDeletionError)
				return fail(e.status, { error: e.message, code: e.code });
			if (e instanceof ApiError) return fail(e.status, { error: e.message });
			console.error('[tmt] account deletion failed', e);
			return fail(500, { error: 'Could not delete the account. Nothing was changed.' });
		}
		redirect(303, '/login?notice=deleted');
	}
};
