import { eq } from 'drizzle-orm';
import { advisoryLock, first, type Db, type DbOrTx } from './db';
import { organizationSettings } from './db/schema';

export interface OrgSettings {
	/** Log finished prints automatically (needs a plate link and slicer grams). */
	autoLogPrints: boolean;
}

type Extra = { autoLogPrints?: boolean };

export async function getOrgSettings(db: DbOrTx, orgId: string): Promise<OrgSettings> {
	const r = await first(
		db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, orgId))
	);
	const extra = (r?.settings ?? {}) as Extra;
	return { autoLogPrints: extra.autoLogPrints === true };
}

/**
 * Read-modify-write of the settings blob. Serialised per workspace with an advisory lock so two
 * concurrent writers (an expected-plate edit and a job attaching) cannot lose each other's change.
 */
async function upsert(
	db: Db,
	orgId: string,
	mutate: (cur: Record<string, unknown>) => Partial<typeof organizationSettings.$inferInsert>
): Promise<void> {
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'org-settings:' + orgId);
		const cur = await first(
			tx.select().from(organizationSettings).where(eq(organizationSettings.organizationId, orgId))
		);
		const settings = { ...((cur?.settings ?? {}) as Record<string, unknown>) };
		const set = mutate(settings);
		const row = { settings, updatedAt: new Date(), ...set };
		if (cur)
			await tx
				.update(organizationSettings)
				.set(row)
				.where(eq(organizationSettings.organizationId, orgId));
		else await tx.insert(organizationSettings).values({ organizationId: orgId, ...row });
	});
}

export async function setOrgSettings(
	db: Db,
	orgId: string,
	patch: Partial<OrgSettings>
): Promise<void> {
	await upsert(db, orgId, (settings) => {
		if (patch.autoLogPrints !== undefined) settings.autoLogPrints = patch.autoLogPrints;
		return {};
	});
}

/** "Start on printer X": the plate the user said they are printing there. A suggestion the user confirms; cleared when a job attaches or ends. */
export interface ExpectedPlate {
	buildId: string;
	plate: number;
	/** The part(s) the next job covers (perPartRuns plates: one color per print). */
	partSlugs?: string[];
	/** The unlinked job that was already running when it was sent, or the first job that started after. */
	jobId?: string;
	at: number;
}
export async function getExpected(
	db: DbOrTx,
	orgId: string,
	printerId: string
): Promise<ExpectedPlate | null> {
	const r = await first(
		db
			.select({ s: organizationSettings.settings })
			.from(organizationSettings)
			.where(eq(organizationSettings.organizationId, orgId))
	);
	const all = ((r?.s ?? {}) as { expected?: Record<string, ExpectedPlate> }).expected ?? {};
	return all[printerId] ?? null;
}
export async function setExpected(
	db: Db,
	orgId: string,
	printerId: string,
	e: ExpectedPlate | null
): Promise<void> {
	await upsert(db, orgId, (settings) => {
		const all = { ...((settings.expected as Record<string, ExpectedPlate>) ?? {}) };
		if (e) all[printerId] = e;
		else delete all[printerId];
		settings.expected = all;
		return {};
	});
}
