import { ApiError, buildAccess, requireEditor, requireNotDemo } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import { checkPartSlugs, checkPieces, expectOnPrinterJob } from '#lib/server/printers/jobs.ts';
import { loadBuildView } from '#lib/server/builds/view.ts';
import { getPrinter } from '#lib/server/printers/store.ts';
import type { RequestHandler } from './$types';

/**
 * "Start on this printer": remember which plate is printing there, as a suggestion to confirm
 * (12 h). For a manual (not connected) printer it only validates the plate and answers
 * `{ manual: true, printer: { id, name } }`.
 */
export const POST: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		requireNotDemo(event.locals.user);
		const p = await getPrinter(db, event.params.id);
		if (!p) throw new ApiError(404, 'Not found');
		await requireEditor(db, p.organizationId, userId);
		const body = (await readJson(event)) as Record<string, unknown>;
		if (typeof body?.buildId !== 'string' || typeof body.plateNumber !== 'number')
			throw new ApiError(400, 'buildId and plateNumber are required');
		const access = await buildAccess(db, body.buildId, userId);
		if (!access || access.organizationId !== p.organizationId)
			throw new ApiError(404, 'Build not found');
		if (access.kind === 'draft') throw new ApiError(400, 'Drafts cannot be linked to print jobs.');
		const view = await loadBuildView(db, body.buildId, userId);
		if (!view || !view.plates.some((pl) => pl.number === body.plateNumber))
			throw new ApiError(400, 'Unknown plate');
		const partSlugs = checkPartSlugs(view, body.plateNumber, body.partSlugs);
		// "Print some pieces…": only after the tenancy check above, on a view of that build; a printer that
		// is not connected validates too.
		const comps = checkPieces(view, body.plateNumber, partSlugs, body.comps);
		// A printer that is not connected never reports a job: nothing to remember or confirm. The
		// caller records the printer on the run it logs (`printer` = the name below).
		if (p.kind === 'manual') return { manual: true, printer: { id: p.id, name: p.name } };
		await expectOnPrinterJob(db, p.id, {
			buildId: body.buildId,
			plate: body.plateNumber,
			...(partSlugs ? { partSlugs } : {}),
			...(comps ? { comps } : {})
		});
	});
