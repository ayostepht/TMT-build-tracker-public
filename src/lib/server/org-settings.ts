import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { organizationSettings } from './db/schema';

export interface OrgSettings {
	/** Log finished prints automatically (needs a plate link and slicer grams). */
	autoLogPrints: boolean;
}

type Extra = { autoLogPrints?: boolean };

export function getOrgSettings(db: Db, orgId: string): OrgSettings {
	const r = db
		.select()
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, orgId))
		.get();
	const extra = (r?.settings ?? {}) as Extra;
	return { autoLogPrints: extra.autoLogPrints === true };
}

function upsert(
	db: Db,
	orgId: string,
	mutate: (cur: Record<string, unknown>) => Partial<typeof organizationSettings.$inferInsert>
) {
	const cur = db
		.select()
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, orgId))
		.get();
	const settings = { ...((cur?.settings ?? {}) as Record<string, unknown>) };
	const set = mutate(settings);
	const row = { settings, updatedAt: new Date(), ...set };
	if (cur)
		db.update(organizationSettings)
			.set(row)
			.where(eq(organizationSettings.organizationId, orgId))
			.run();
	else
		db.insert(organizationSettings)
			.values({ organizationId: orgId, ...row })
			.run();
}

export function setOrgSettings(db: Db, orgId: string, patch: Partial<OrgSettings>): void {
	upsert(db, orgId, (settings) => {
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
export function getExpected(db: Db, orgId: string, printerId: string): ExpectedPlate | null {
	const r = db
		.select({ s: organizationSettings.settings })
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, orgId))
		.get();
	const all = ((r?.s ?? {}) as { expected?: Record<string, ExpectedPlate> }).expected ?? {};
	return all[printerId] ?? null;
}
export function setExpected(
	db: Db,
	orgId: string,
	printerId: string,
	e: ExpectedPlate | null
): void {
	upsert(db, orgId, (settings) => {
		const all = { ...((settings.expected as Record<string, ExpectedPlate>) ?? {}) };
		if (e) all[printerId] = e;
		else delete all[printerId];
		settings.expected = all;
		return {};
	});
}
