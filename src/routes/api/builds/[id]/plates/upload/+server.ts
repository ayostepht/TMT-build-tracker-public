import { getDb } from '#lib/server/db/index.ts';
import { ApiError, buildAccess, requireNotDemo } from '#lib/server/access.ts';
import { createUpload } from '#lib/server/builds/plates.ts';
import { loadBuildView } from '#lib/server/builds/view.ts';
import { diskHasRoom } from '#lib/server/config.ts';
import { acquireUploadSlot, assertUploadRoom } from '#lib/server/quota.ts';
import { receiveThreeMf } from '#lib/server/threemf/upload.ts';
import { requireUserId, respond } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		requireNotDemo(event.locals.user);
		const access = await buildAccess(db, event.params.id, userId);
		if (!access) throw new ApiError(404, 'Not found');
		if (!access.canEdit) throw new ApiError(403, 'Your role cannot edit');
		// Slot first (429), then "already over the upload space?" (409), then the disk guard (507) inside receive.
		const release = await acquireUploadSlot(db, event.locals.user!);
		try {
			await assertUploadRoom(db, access.organizationId, 0, { userId });
			const up = await receiveThreeMf(event.request, event.url.searchParams.get('name'), {
				hasRoom: diskHasRoom
			});
			const view = await loadBuildView(db, event.params.id, userId);
			if (!view) throw new ApiError(404, 'Not found');
			return await createUpload(
				db,
				event.params.id,
				userId,
				{ name: up.fileName, size: up.size },
				up.summary,
				view
			);
		} finally {
			release();
		}
	});
