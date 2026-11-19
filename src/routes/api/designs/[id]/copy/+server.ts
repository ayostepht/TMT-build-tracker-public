import { getDb } from '#lib/server/db/index.ts';
import { copyGalleryDesign } from '#lib/server/designs/gallery.ts';
import { requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

/** "Use this design": save a private copy of a gallery design as your own. */
export const POST: RequestHandler = (event) =>
	respond(async () => copyGalleryDesign(getDb(), event.params.id, requireUserId(event)));
