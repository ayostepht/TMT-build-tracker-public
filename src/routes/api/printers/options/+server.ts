import { CONNECTION_OPTIONS } from '#lib/printers/connection-options.ts';
import { requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/**
 * The ways a printer can be added (an OctoEverywhere link, or not connected), with the fields each
 * needs. Any signed-in user; nothing here is workspace data.
 */
export const GET: RequestHandler = (event) =>
	respond(() => {
		requireUserId(event);
		return { connectionOptions: CONNECTION_OPTIONS };
	});
