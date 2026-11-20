import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { first } from '../db';
import { buildFilaments, templates } from '../db/schema';
import {
	addRun,
	printingAction,
	setPartStatus,
	updateBuild,
	updateFilament
} from '../builds/actions';
import { setAssemblyItem } from '../builds/assembly';
import { createBuild } from '../builds/create';
import { loadBuildView } from '../builds/view';
import { createDesign } from '../designs/designs';
import { findPersonalWorkspace } from '../teams';

/** The sample palette: the same colors the public home page shows. */
const SAMPLE_COLORS: Record<string, { name: string; hex: string }> = {
	primary: { name: 'Deep teal', hex: '#2f5d62' },
	accent: { name: 'Ochre', hex: '#e0a458' },
	soft: { name: 'Sand', hex: '#efe6d2' },
	tire: { name: 'Charcoal', hex: '#3a3631' }
};

const DEFAULT_TEMPLATE_SLUG = 'makegood-tmt-revb';

const day = (daysAgo: number) =>
	new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/**
 * Give a demo user one realistic sample build, through the same functions the app uses
 * (`createBuild`, `updateFilament`, `addRun`, `printingAction`, `setAssemblyItem`, `createDesign`), so
 * the seed stays valid as the rules change: a few plates printed (one needed a second try), one plate
 * printing now, parts of another marked for reprint, two assembly items ticked, and the colors saved as
 * a design. No personal data. Returns the build id. The caller deletes the user if this throws.
 */
export async function seedDemoBuild(db: Db, userId: string): Promise<string> {
	const ws = await findPersonalWorkspace(db, userId);
	if (!ws) throw new Error('demo user has no personal workspace');
	const tpl =
		(await first(
			db
				.select({ id: templates.id })
				.from(templates)
				.where(and(eq(templates.slug, DEFAULT_TEMPLATE_SLUG), isNull(templates.ownerOrgId)))
		)) ??
		(await first(
			db.select({ id: templates.id }).from(templates).where(isNull(templates.ownerOrgId))
		));
	if (!tpl) throw new Error('no built-in kit to seed the demo from');

	const deliver = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
	const buildId = await createBuild(
		db,
		{
			organizationId: ws.id,
			templateId: tpl.id,
			designId: null,
			name: 'Sample chair',
			deliveryDate: deliver
		},
		userId
	);

	// Each query is a round trip to the database and the seed makes hundreds, so it reads only what
	// it needs: the color slots straight from their table (not through the whole build view), and
	// the view once, for its plates and assembly steps.
	const slots = await db
		.select({ key: buildFilaments.roleKey })
		.from(buildFilaments)
		.where(eq(buildFilaments.buildId, buildId));
	const present = new Set(slots.map((r) => r.key));
	for (const [key, c] of Object.entries(SAMPLE_COLORS)) {
		if (present.has(key))
			await updateFilament(db, buildId, userId, key, { name: c.name, hex: c.hex });
	}
	await updateBuild(db, buildId, userId, { phase: 'printing' });

	const view = (await loadBuildView(db, buildId, userId))!;
	// Single-run plates with parts, in plate order.
	const plates = view.plates.filter((p) => p.runs === 1 && !p.perPartRuns && p.parts.length > 0);
	if (plates.length < 6) throw new Error('the demo kit needs at least six single-run plates');
	const printer = 'Workshop printer';
	// Plates 1-3 printed (the second took two tries), plate 4 printing now, plate 5 partly reprinted.
	const [a, b, c, d, e] = plates;
	await addRun(db, buildId, userId, {
		plateNumber: a.number,
		date: day(9),
		result: 'Success',
		grams: 212,
		hours: 13.1,
		printer,
		note: 'First try, no supports trouble.'
	});
	await addRun(db, buildId, userId, {
		plateNumber: b.number,
		date: day(8),
		result: 'Failed',
		grams: 64,
		hours: 4.2,
		printer,
		note: 'Lifted off the bed corner. Cleaned the plate and tried again.'
	});
	await addRun(db, buildId, userId, {
		plateNumber: b.number,
		date: day(7),
		result: 'Success',
		grams: 214,
		hours: 13.2,
		printer
	});
	await addRun(db, buildId, userId, {
		plateNumber: c.number,
		date: day(4),
		result: 'Success',
		grams: 198,
		hours: 12.4,
		printer
	});
	// One part of the fifth plate came out badly: mark it to reprint.
	if (e.parts[0]) await setPartStatus(db, buildId, userId, e.parts[0], { status: 'Reprint' });
	// The fourth plate is on the printer right now, started two hours ago.
	await printingAction(db, buildId, userId, { action: 'start', slugs: d.parts, printer });
	await printingAction(db, buildId, userId, {
		action: 'setStart',
		slugs: d.parts,
		when: new Date(Date.now() - 2 * 3_600_000).toISOString()
	});

	let ticked = 0;
	for (const step of view.assembly.steps) {
		if (ticked >= 2) break;
		await setAssemblyItem(db, buildId, userId, step.key, { done: true });
		ticked++;
	}

	// Save the sample colors as a design so the Designs page has one too.
	await createDesign(db, userId, { buildId, name: 'Sample colors' });
	return buildId;
}
