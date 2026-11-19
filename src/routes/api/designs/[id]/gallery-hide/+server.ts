import { getDb } from '#lib/server/db/index.ts';
import { liftGalleryHide } from '#lib/server/designs/gallery.ts';
import { requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/** A site admin lets the author share a design again after hiding it from the gallery. */
export const DELETE: RequestHandler = (event) =>
	respond(async () => {
		requireUserId(event);
		await liftGalleryHide(getDb(), event.params.id, event.locals.user!);
	});
