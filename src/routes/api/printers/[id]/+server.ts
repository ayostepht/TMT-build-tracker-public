import { ApiError, requireEditor, requireNotDemo } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import { deletePrinter, getPrinter, toPublic, updatePrinter } from '#lib/server/printers/store.ts';
import { getSupervisor } from '#lib/server/printers/supervisor.ts';
import { cameraChanged } from '#lib/server/printers/camera-access.ts';
import type { RequestHandler } from './$types';

async function orgOf(id: string, userId: string): Promise<string> {
	const db = getDb();
	const p = await getPrinter(db, id);
	if (!p) throw new ApiError(404, 'Not found');
	await requireEditor(db, p.organizationId, userId); // 404 for non-members, 403 for viewers
	return p.organizationId;
}

export const PATCH: RequestHandler = (event) =>
	respond(async () => {
		requireNotDemo(event.locals.user);
		const org = await orgOf(event.params.id, requireUserId(event));
		const row = await updatePrinter(getDb(), event.params.id, org, await readJson(event));
		await getSupervisor()?.refresh(row.id);
		cameraChanged(row.id);
		return { printer: toPublic(row) };
	});

export const DELETE: RequestHandler = (event) =>
	respond(async () => {
		requireNotDemo(event.locals.user);
		const org = await orgOf(event.params.id, requireUserId(event));
		await deletePrinter(getDb(), event.params.id, org);
		cameraChanged(event.params.id);
		getSupervisor()?.remove(event.params.id);
	});
