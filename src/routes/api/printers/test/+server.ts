import { shareLinkFor } from '#lib/printers/share-link.ts';
import { ApiError, requireEditor } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import { resolveAllowed } from '#lib/server/printers/outbound.ts';
import {
	HOSTED_LINK_FAILURE,
	limitTests,
	uniformHostedFailure
} from '#lib/server/printers/test-limit.ts';
import { configFromInput } from '#lib/server/printers/store.ts';
import { testConnection } from '#lib/server/printers/supervisor.ts';
import type { RequestHandler } from './$types';

/** Connect once with the typed (or stored) settings and report a live status snapshot. */
export const POST: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		const body = (await readJson(event)) as Record<string, unknown>;
		const org = typeof body?.organizationId === 'string' ? body.organizationId : '';
		if (!org) throw new ApiError(400, 'organizationId is required');
		requireEditor(db, org, userId);
		limitTests(userId);
		const cfg = configFromInput(db, org, body);
		// Not connected: nothing to dial, nothing to test.
		if (cfg.kind === 'manual')
			return {
				connected: false,
				manual: true,
				status: null,
				message: 'This printer is not connected, so there is nothing to test.'
			};
		// The destination is the OctoEverywhere link's host (a validated public address); a refusal
		// reads the same as any other failure, so the route cannot confirm a guessed link.
		const link = shareLinkFor(cfg.kind, cfg.secrets);
		if (!link) throw new ApiError(400, HOSTED_LINK_FAILURE);
		await uniformHostedFailure(() =>
			resolveAllowed(link.host, undefined, { allowShareLink: true })
		);
		const r = await testConnection(cfg);
		// One wording for every failure, and no status that might carry another.
		if (!r.ok) return { connected: false, status: null, message: HOSTED_LINK_FAILURE };
		return { connected: r.ok, status: r.status, message: r.message };
	});
