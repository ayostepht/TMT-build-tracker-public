import { cameraSupported } from '#lib/printers/camera-url.ts';
import { shareLinkFor } from '#lib/printers/share-link.ts';
import { ApiError, requireEditor, requireNotDemo } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import { grabFrame } from '#lib/server/printers/camera.ts';
import { resolveCameraSource } from '#lib/server/printers/camera-source.ts';
import { resolveAllowed } from '#lib/server/printers/outbound.ts';
import {
	HOSTED_CAMERA_FAILURE,
	HOSTED_LINK_FAILURE,
	limitTests,
	uniformHostedFailure
} from '#lib/server/printers/test-limit.ts';
import { configFromInput } from '#lib/server/printers/store.ts';
import type { RequestHandler } from './$types';

/**
 * Settings "Test": fetch one frame through the typed (or stored) link and send it back as a data
 * URL for the preview. Editors only; the outbound guard applies to where it connects.
 */
export const POST: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		requireNotDemo(event.locals.user);
		const body = (await readJson(event)) as Record<string, unknown>;
		const org = typeof body?.organizationId === 'string' ? body.organizationId : '';
		if (!org) throw new ApiError(400, 'organizationId is required');
		await requireEditor(db, org, userId);
		limitTests(userId);
		const cfg = await configFromInput(db, org, body);
		if (cfg.kind === 'manual')
			return { works: false, message: 'This printer is not connected, so it has no camera.' };
		// The destination is the OctoEverywhere link's host (a validated public address).
		const link = shareLinkFor(cfg.kind, cfg.secrets);
		if (!link) throw new ApiError(400, HOSTED_LINK_FAILURE);
		await uniformHostedFailure(() =>
			resolveAllowed(link.host, undefined, { allowShareLink: true })
		);
		if (!cameraSupported(cfg.kind))
			return { works: false, message: 'This printer type has no camera support.' };
		const src = await resolveCameraSource({
			kind: cfg.kind,
			cameraEnabled: true,
			secrets: cfg.secrets
		});
		if (!src) return { works: false, message: HOSTED_CAMERA_FAILURE };
		try {
			const jpg = await grabFrame(src);
			return {
				works: true,
				image: `data:image/jpeg;base64,${jpg.toString('base64')}`,
				origin: src.origin
			};
		} catch {
			return { works: false, message: HOSTED_CAMERA_FAILURE };
		}
	});
