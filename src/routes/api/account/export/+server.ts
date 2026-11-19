import { json } from '@sveltejs/kit';
import { exportAccountData } from '#lib/server/account.ts';
import { ApiError, requireNotDemo } from '#lib/server/access.ts';
import { requireUserId } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { RequestHandler } from './$types';

/** The signed-in user's own data as one JSON download (profile, memberships, personal builds). */
export const GET: RequestHandler = async (event) => {
	try {
		const userId = requireUserId(event);
		requireNotDemo(event.locals.user);
		const body = await exportAccountData(getDb(), userId);
		return new Response(body, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': 'attachment; filename="tmt-my-data.json"',
				'cache-control': 'no-store'
			}
		});
	} catch (e) {
		if (e instanceof ApiError) return json({ error: e.message }, { status: e.status });
		console.error('[tmt] account export failed', e);
		return json({ error: 'Internal error' }, { status: 500 });
	}
};
