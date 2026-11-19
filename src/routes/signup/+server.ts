import { redirect } from '@sveltejs/kit';
import { safeRedirect } from '#lib/server/teams.ts';
import type { RequestHandler } from './$types';

/** There is no sign-up form: signing in with a provider creates the account. Keeps a safe `redirect`. */
export const GET: RequestHandler = ({ url }) => {
	const to = safeRedirect(url.searchParams.get('redirect'));
	redirect(303, to ? `/login?redirect=${encodeURIComponent(to)}` : '/login');
};
