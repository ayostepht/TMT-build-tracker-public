import { redirect } from '@sveltejs/kit';
import { accountsPaused, loginErrorMessage } from '#lib/server/auth-policy.ts';
import { enabledProviderIds } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import { safeRedirect } from '#lib/server/teams.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
	// The page differs per query (error, notice) and per session: never share it.
	setHeaders({ 'cache-control': 'private, no-cache' });
	const to = safeRedirect(url.searchParams.get('redirect'));
	// A signed-in real account goes on; a demo visitor may sign in for real (that starts a fresh account).
	if (locals.user && !(locals.user as { isDemo?: boolean }).isDemo)
		redirect(303, to ?? '/workspace');
	return {
		providers: enabledProviderIds(),
		accountsPaused: await accountsPaused(getDb()),
		redirectTo: to,
		inDemo: !!locals.user,
		// Fixed texts only: the query string never reaches the page as text.
		notice:
			url.searchParams.get('notice') === 'deleted'
				? 'Your account was deleted.'
				: url.searchParams.get('notice') === 'demo-ended'
					? 'The demo was deleted.'
					: null,
		authError: loginErrorMessage(url.searchParams.get('error'))
	};
};
