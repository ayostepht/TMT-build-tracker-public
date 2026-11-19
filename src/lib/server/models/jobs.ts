import { unlink } from 'node:fs/promises';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../access.ts';
import { templateModelPath } from '../config.ts';
import { assertUnder, QuotaError, quotaLimit } from '../quota.ts';
import { advisoryLock, first, type Db, type DbOrTx } from '../db/index.ts';
import { templateModelJobs, templateModels, templateParts } from '../db/schema.ts';
import { convertStepZip, type ConvertResult, type ConvertTemplate } from './convert.ts';

export type ModelJob = typeof templateModelJobs.$inferSelect;
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type Converter = (
	zipPath: string,
	template: ConvertTemplate,
	onProgress: (pct: number, message: string) => void
) => Promise<ConvertResult>;

let converter: Converter = convertStepZip;
/** Tests swap the converter for a fake. */
export function setConverter(fn: Converter | null): void {
	converter = fn ?? convertStepZip;
}

/** Conversions a user has queued or running (they hold CPU; finished and failed ones free the slot). */
export async function countActiveConversions(db: DbOrTx, userId: string): Promise<number> {
	const r = await first(
		db
			.select({ n: count() })
			.from(templateModelJobs)
			.where(
				and(
					eq(templateModelJobs.createdBy, userId),
					inArray(templateModelJobs.status, ['queued', 'running'])
				)
			)
	);
	return r?.n ?? 0;
}

/**
 * Refuses (QuotaError, 409, code 'quota') when the user already has `stepConversionsPerUser`
 * conversions queued or running. Site admins and unlimited installs pass. Cheap: use it before
 * streaming an upload; `createJob` repeats it atomically with the insert.
 */
export async function assertConversionSlot(db: DbOrTx, userId: string | null): Promise<void> {
	if (!userId) return;
	try {
		await assertUnder(db, 'stepConversionsPerUser', () => countActiveConversions(db, userId), {
			userId
		});
	} catch (e) {
		if (e instanceof QuotaError) {
			const limit = quotaLimit('stepConversionsPerUser') ?? 0;
			throw new QuotaError(
				limit === 0
					? 'Model conversions are not allowed on this server. Ask the admin.'
					: `You already have ${limit === 1 ? 'a model conversion' : `${limit} model conversions`} queued or running, the limit on this server. Wait for it to finish and try again.`
			);
		}
		throw e;
	}
}

export async function createJob(
	db: Db,
	input: { templateId: string; inputPath: string; userId: string | null; fileName: string }
): Promise<ModelJob> {
	return db.transaction(async (tx) => {
		// Count and insert under one lock: parallel requests cannot both pass.
		await advisoryLock(tx, 'model-job-create');
		return insertJob(tx, input);
	});
}

async function insertJob(
	db: DbOrTx,
	input: { templateId: string; inputPath: string; userId: string | null; fileName: string }
): Promise<ModelJob> {
	await assertConversionSlot(db, input.userId);
	const active = await first(
		db
			.select({ id: templateModelJobs.id })
			.from(templateModelJobs)
			.where(
				and(
					eq(templateModelJobs.templateId, input.templateId),
					inArray(templateModelJobs.status, ['queued', 'running'])
				)
			)
	);
	if (active) throw new ApiError(409, 'A conversion for this kit is already queued or running');
	const [row] = await db
		.insert(templateModelJobs)
		.values({
			templateId: input.templateId,
			inputPath: input.inputPath,
			createdBy: input.userId,
			// While queued, the message holds the uploaded file name (used for the model's source note).
			message: input.fileName.slice(0, 200)
		})
		.returning();
	return row;
}

export async function getJob(
	db: DbOrTx,
	templateId: string,
	jobId: string
): Promise<ModelJob | undefined> {
	return first(
		db
			.select()
			.from(templateModelJobs)
			.where(and(eq(templateModelJobs.id, jobId), eq(templateModelJobs.templateId, templateId)))
	);
}

export async function latestJob(db: DbOrTx, templateId: string): Promise<ModelJob | undefined> {
	return first(
		db
			.select()
			.from(templateModelJobs)
			.where(eq(templateModelJobs.templateId, templateId))
			.orderBy(desc(templateModelJobs.createdAt), desc(templateModelJobs.id))
	);
}

/** A server restart kills the converter child: mark jobs that were running as failed. */
export async function failStaleModelJobs(db: DbOrTx): Promise<number> {
	const stale = await db
		.update(templateModelJobs)
		.set({ status: 'failed', message: 'Interrupted by a server restart', finishedAt: new Date() })
		.where(eq(templateModelJobs.status, 'running'))
		.returning({ id: templateModelJobs.id, inputPath: templateModelJobs.inputPath });
	for (const j of stale) void unlink(j.inputPath).catch(() => {});
	return stale.length;
}

const quiet = () => {};

async function processJob(db: Db, job: ModelJob): Promise<void> {
	const fileName = job.message || 'upload.zip';
	await db
		.update(templateModelJobs)
		.set({ status: 'running', progress: 1, message: 'Starting' })
		.where(eq(templateModelJobs.id, job.id));
	let lastPct = -1;
	// Progress writes are fire-and-forget (a failed one must not abort the conversion).
	const onProgress = (pct: number, message: string) => {
		if (pct === lastPct && !message) return;
		lastPct = pct;
		void db
			.update(templateModelJobs)
			.set({ progress: Math.min(99, Math.max(1, Math.round(pct))), message })
			.where(eq(templateModelJobs.id, job.id))
			.catch(quiet);
	};
	try {
		const parts = await db
			.select({
				slug: templateParts.slug,
				sourceFile: templateParts.sourceFile,
				components: templateParts.components
			})
			.from(templateParts)
			.where(eq(templateParts.templateId, job.templateId))
			.orderBy(asc(templateParts.sort));
		const result = await converter(job.inputPath, { id: job.templateId, parts }, onProgress);
		const ok = result.report.filter((r) => r.status === 'ok').length;
		const missing = result.report.filter((r) => r.status === 'missing').length;
		const failed = result.report.filter((r) => r.status === 'failed').length;
		const sourceNote = `${fileName}: ${result.slugs.length} parts built from ${ok} files, ${missing} missing, ${failed} failed`;
		await db.transaction(async (tx) => {
			await tx
				.insert(templateModels)
				.values({
					templateId: job.templateId,
					glbPath: templateModelPath(job.templateId),
					version: result.version,
					size: result.size,
					slugs: result.slugs,
					sourceNote,
					createdBy: job.createdBy
				})
				.onConflictDoUpdate({
					target: templateModels.templateId,
					set: {
						glbPath: templateModelPath(job.templateId),
						version: result.version,
						size: result.size,
						slugs: result.slugs,
						sourceNote,
						createdBy: job.createdBy,
						createdAt: new Date()
					}
				});
			await tx
				.update(templateModelJobs)
				.set({
					status: 'done',
					progress: 100,
					message: sourceNote,
					report: result.report as unknown as Record<string, unknown>[],
					finishedAt: new Date()
				})
				.where(eq(templateModelJobs.id, job.id));
		});
	} catch (e) {
		await db
			.update(templateModelJobs)
			.set({
				status: 'failed',
				message: e instanceof Error ? e.message : String(e),
				finishedAt: new Date()
			})
			.where(eq(templateModelJobs.id, job.id));
	} finally {
		await unlink(job.inputPath).catch(quiet);
	}
}

let draining: Promise<void> | null = null;

/** Runs queued jobs one at a time, oldest first. Resolves when the queue is empty; concurrent calls share the run. */
export function runQueue(db: Db): Promise<void> {
	if (draining) return draining;
	draining = (async () => {
		// Let `draining` be assigned before the first check, or an empty queue would leave a stale promise behind.
		await Promise.resolve();
		try {
			for (;;) {
				const next = await first(
					db
						.select()
						.from(templateModelJobs)
						.where(eq(templateModelJobs.status, 'queued'))
						.orderBy(asc(templateModelJobs.createdAt), asc(templateModelJobs.id))
				);
				if (!next) return;
				await processJob(db, next);
			}
		} finally {
			draining = null;
		}
	})();
	return draining;
}

/** Fire-and-forget version of `runQueue` for request handlers and startup. */
export function kickQueue(db: Db): void {
	runQueue(db).catch((e) => console.error('[tmt] model queue error', e));
}
