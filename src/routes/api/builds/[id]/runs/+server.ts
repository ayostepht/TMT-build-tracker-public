import { getDb } from '#lib/server/db/index.ts';
import { addRun } from '#lib/server/builds/actions.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/**
 * Log a run. A Partial with `split` ({ keptSlugs, keptGrams, lostGrams }) makes two runs; `id` is
 * the printed (kept) one and `ids` lists both.
 */
export const POST: RequestHandler = (event) =>
	respond(async () => {
		const { runId, runIds } = addRun(
			getDb(),
			event.params.id,
			requireUserId(event),
			await readJson(event)
		);
		return { id: runId, ids: runIds };
	});
