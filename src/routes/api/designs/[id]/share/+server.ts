import { getDb } from '#lib/server/db/index.ts';
import { shareDesign, unshareDesign } from '#lib/server/designs/gallery.ts';
import { requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/** List the design in the shared gallery. Author only; limited per person per day. */
export const POST: RequestHandler = (event) =>
	respond(() => shareDesign(getDb(), event.params.id, requireUserId(event)));

/** Take it out of the gallery: the author, or a site admin (moderation). Copies stay. */
export const DELETE: RequestHandler = (event) =>
	respond(async () => {
		requireUserId(event);
		return unshareDesign(getDb(), event.params.id, event.locals.user!);
	});
