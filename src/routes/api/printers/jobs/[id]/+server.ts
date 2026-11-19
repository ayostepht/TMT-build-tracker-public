import { ApiError, requireEditor, requireNotDemo } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { confirmJobRuns, dismissJob, linkJob, unlinkJob } from '#lib/server/printers/jobs.ts';
import { printerJobs, printers } from '#lib/server/db/schema.ts';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Actions on a printer job: link / unlink to a plate, confirm the print log, dismiss the prompt. Editors. */
export const POST: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		requireNotDemo(event.locals.user);
		const row = await first(
			db
				.select({ org: printers.organizationId, buildId: printerJobs.buildId })
				.from(printerJobs)
				.innerJoin(printers, eq(printers.id, printerJobs.printerId))
				.where(eq(printerJobs.id, event.params.id))
		);
		if (!row) throw new ApiError(404, 'Not found');
		await requireEditor(db, row.org, userId);
		const body = (await readJson(event)) as Record<string, unknown>;
		const id = event.params.id;
		switch (body?.action) {
			case 'link': {
				if (typeof body.buildId !== 'string' || typeof body.plateNumber !== 'number')
					throw new ApiError(400, 'buildId and plateNumber are required');
				await linkJob(db, id, row.org, userId, body.buildId, body.plateNumber, body.partSlugs);
				return {};
			}
			case 'unlink':
				await unlinkJob(db, id, row.org);
				return {};
			case 'confirm': {
				const { runId, runIds } = await confirmJobRuns(db, id, row.org, userId, body);
				return { runId, runIds };
			}
			case 'dismiss':
				await dismissJob(db, id, row.org, userId);
				return {};
			default:
				throw new ApiError(400, 'Unknown action');
		}
	});
