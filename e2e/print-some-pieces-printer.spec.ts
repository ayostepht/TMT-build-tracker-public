import { expect, test } from './fixtures';
import { keepPrintedVisible, ownerWithBuild, row } from './helpers';
import { confirmWhere } from './status-helpers';
import type { Locator, Page } from '@playwright/test';

/**
 * "Print some pieces…" with a printer in the team: confirming a subset asks "Where is it printing?"
 * and names the pieces of Harness and Straps (slug `harness`, 9 pieces, alone on plate 18 of the
 * tuned layout). This edition has no live-printer e2e seam (link printers need a real OctoEverywhere
 * share link), so the team's printer is a "Not connected" one, as in
 * print-some-parts-printer.spec.ts: it covers the dialog, the direct start for the picked pieces and
 * that nothing is queued for a printer. Linking a job to the picked pieces, finishing it and a
 * stopped job belong in the server tests (`jobs.pieces.test.ts`).
 */

const HARNESS = 'harness';
const N = 9;
const PLATE = 18;
const PICKED = [0, 1, 2];

interface ViewJson {
	parts: { slug: string; components: { name: string }[] }[];
	state: Record<
		string,
		{ status: string; comps: Record<string, boolean>; printingComps?: number[] | null }
	>;
}
interface JobsJson {
	organizationId: string;
	expected: { plateNumber: number; partSlugs: string[] | null; comps?: number[] | null }[];
}

const view = async (page: Page, id: string) =>
	(await (await page.request.get(`/api/builds/${id}/view`)).json()) as ViewJson;
const jobs = async (page: Page, id: string) =>
	(await (await page.request.get(`/api/builds/${id}/printer-jobs`)).json()) as JobsJson;

/** A build in a team with one "Not connected" printer. */
async function setup(page: Page, label: string) {
	const { buildId } = await ownerWithBuild(page, label);
	const { organizationId } = await jobs(page, buildId);
	const created = await page.request.post('/api/printers', {
		data: { organizationId, name: 'Pieces Bench', kind: 'manual' },
		headers: { origin: new URL(page.url()).origin }
	});
	expect(created.ok()).toBe(true);
	return { buildId };
}

/** Print tab, grouped by plate: returns plate 18's heading. */
async function openPrint(page: Page, buildId: string) {
	await keepPrintedVisible(page, buildId);
	await page.goto(`/builds/${buildId}/print`);
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Group by').selectOption('plate');
	const h = page.locator('.group-head').filter({
		has: page.locator(`[data-testid="plate-status"][aria-label^="Plate ${PLATE} status"]`)
	});
	await expect(h).toBeVisible();
	return h;
}

/** Picks the first three pieces in the picker and confirms. */
async function pickSome(page: Page, buildId: string): Promise<Locator> {
	const h = await openPrint(page, buildId);
	await h.getByTestId('plate-print-some-pieces').click();
	const dlg = h.getByTestId('piece-pick');
	await expect(dlg).toBeVisible();
	const items = dlg.getByTestId('piece-pick-item');
	for (let i = PICKED.length; i < N; i++) await items.nth(i).getByRole('checkbox').uncheck();
	await expect(dlg.getByTestId('piece-pick-confirm')).toHaveText(
		`Mark ${PICKED.length} of ${N} pieces printing`
	);
	await dlg.getByTestId('piece-pick-confirm').click();
	return h;
}

test('Some pieces with a printer: Where is it printing names the pieces, then only they print', async ({
	page
}) => {
	const { buildId } = await setup(page, 'pcprinter');
	const h = await pickSome(page, buildId);
	const v0 = await view(page, buildId);
	const pieceNames = PICKED.map(
		(i) => v0.parts.find((p) => p.slug === HARNESS)!.components[i].name
	);

	// The dialog names the pieces.
	const where = page.getByTestId('where-printing');
	await expect(where).toBeVisible();
	await expect(where.getByTestId('where-parts')).toContainText(
		`3 of ${N} pieces of Harness and Straps: ${pieceNames.join(', ')}`
	);
	await confirmWhere(page, 'first');
	await expect(row(page, HARNESS)).toHaveAttribute('data-s', 'Printing');
	await expect(row(page, HARNESS).getByTestId('part-pieces')).toHaveText(
		`0/${N} pieces · 3 printing`
	);
	expect((await view(page, buildId)).state[HARNESS].printingComps).toEqual(PICKED);
	await expect(h.getByTestId('plate-print-some-pieces')).toHaveCount(0);
	// A not-connected printer queues nothing.
	expect((await jobs(page, buildId)).expected).toHaveLength(0);
});

test('"Not on a connected printer" keeps the direct start for the picked pieces', async ({
	page
}) => {
	const { buildId } = await setup(page, 'pcnone');
	await pickSome(page, buildId);
	await confirmWhere(page, 'none');
	await expect(row(page, HARNESS)).toHaveAttribute('data-s', 'Printing');
	await expect(row(page, HARNESS).getByTestId('part-pieces')).toHaveText(
		`0/${N} pieces · 3 printing`
	);
	expect((await view(page, buildId)).state[HARNESS].printingComps).toEqual(PICKED);
	expect((await jobs(page, buildId)).expected).toHaveLength(0);
});
