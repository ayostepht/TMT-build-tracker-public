import { getDb } from '#lib/server/db/index.ts';
import { addCustomPiece } from '#lib/server/builds/custom-pieces.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/**
 * Add the parsed upload as a custom piece (an accessory or beta replacement) instead of replacing the
 * build's plates: `{ name, plates?, runs?, times?, grams?, filamentMap, role?, replaces? }` (editor or owner).
 * Demo users cannot upload, so they have no parsed upload to add.
 */
export const POST: RequestHandler = (event) =>
	respond(async () =>
		addCustomPiece(
			getDb(),
			event.params.id,
			requireUserId(event),
			event.params.uploadId,
			await readJson(event)
		)
	);
