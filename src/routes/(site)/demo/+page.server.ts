import { fail, redirect } from '@sveltejs/kit';
import { getAuth } from '#lib/server/auth-instance.ts';
import { demoConfig } from '#lib/server/config.ts';
import { DemoBusyError, DemoRateError, startDemo } from '#lib/server/demo/index.ts';
import { getDb } from '#lib/server/db/index.ts';
import { liveDemoCount } from '#lib/server/demo/cleanup.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-cache' });
	// Someone with a real account has no use for the demo.
	if (locals.user && !(locals.user as { isDemo?: boolean }).isDemo) redirect(303, '/workspace');
	const cfg = demoConfig();
	return {
		inDemo: !!locals.user,
		hours: Math.round(cfg.ttlMs / 3_600_000),
		busy: (await liveDemoCount(getDb())) >= cfg.maxLive
	};
};

export const actions: Actions = {
	/** Starts a demo: a throwaway user, a sample build and a session that ends within 24 hours. */
	start: async ({ locals, cookies, getClientAddress }) => {
		if (locals.user) redirect(303, '/workspace');
		let ip: string;
		try {
			ip = getClientAddress();
		} catch {
			return fail(400, { error: 'The demo could not tell where you are connecting from.' });
		}
		let buildId: string;
		try {
			buildId = await startDemo(getAuth(), ip, cookies);
		} catch (e) {
			if (e instanceof DemoBusyError) return fail(503, { busy: true });
			if (e instanceof DemoRateError)
				return fail(429, {
					error: 'That is a lot of demos from one address. Please try again in a while.',
					retryAfter: e.retryAfter
				});
			console.error('[tmt] demo start failed', e);
			return fail(500, { error: 'The demo could not start. Please try again in a moment.' });
		}
		// Open straight into the build's tracking view: this is what the tracker is for.
		redirect(303, `/builds/${buildId}/print`);
	}
};
