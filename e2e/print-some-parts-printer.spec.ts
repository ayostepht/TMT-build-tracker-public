import { expect, test } from './fixtures';
import { keepPrintedVisible, ownerWithBuild, row } from './helpers';
import { chooseStatus, confirmWhere } from './status-helpers';
import type { Page } from '@playwright/test';

/**
 * "Print some parts…" with a printer in the team: confirming a subset asks "Where is it printing?"
 * and names the parts. This edition has no live-printer e2e seam (link printers need a real
 * OctoEverywhere share link), so the team's printer is a "Not connected" one: it covers the dialog,
 * the direct start for the picked parts and that nothing is queued for a printer. Linking a job to
 * the picked parts is covered by `jobs.test.ts` ("some parts of a plate on a printer") and
 * `printer-match.test.ts`.
 */

interface ViewJson {
	plates: { number: number; parts: string[]; perPartRuns: boolean; runs: number }[];
	state: Record<string, { status: string }>;
}
interface JobsJson {
	organizationId: string;
	expected: { plateNumber: number; partSlugs: string[] | null }[];
}

const view = async (page: Page, id: string) =>
	(await (await page.request.get(`/api/builds/${id}/view`)).json()) as ViewJson;
const jobs = async (page: Page, id: string) =>
	(await (await page.request.get(`/api/builds/${id}/printer-jobs`)).json()) as JobsJson;

/** A build in a team with one "Not connected" printer, and its biggest single-run plate. */
async function setup(page: Page, label: string) {
	const { buildId } = await ownerWithBuild(page, label);
	const { organizationId } = await jobs(page, buildId);
	const created = await page.request.post('/api/printers', {
		data: { organizationId, name: 'Subset Bench', kind: 'manual' },
		headers: { origin: new URL(page.url()).origin }
	});
	expect(created.ok()).toBe(true);
	const ok = (await view(page, buildId)).plates.filter(
		(p) => !p.perPartRuns && p.runs <= 1 && p.parts.length >= 3
	);
	expect(ok.length).toBeGreaterThan(0);
	const plate = ok.sort((a, b) => b.parts.length - a.parts.length)[0];
	return { buildId, plate };
}

/** Print tab, grouped by plate: pick all but the first part and confirm; returns the picked slugs. */
async function pickSome(page: Page, buildId: string, plate: { number: number; parts: string[] }) {
	await keepPrintedVisible(page, buildId);
	await page.goto(`/builds/${buildId}/print`);
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Group by').selectOption('plate');
	const head = page.locator('.group-head').filter({
		has: page.locator(`[data-testid="plate-status"][aria-label^="Plate ${plate.number} status"]`)
	});
	await head.getByTestId('plate-print-some').click();
	const dlg = head.getByTestId('part-pick');
	await expect(dlg).toBeVisible();
	await dlg.getByTestId('part-pick-item').first().getByRole('checkbox').uncheck();
	await dlg.getByTestId('part-pick-confirm').click();
	return plate.parts.slice(1);
}

test('Some parts with a printer: Where is it printing names the parts, then only they print', async ({
	page
}) => {
	const { buildId, plate } = await setup(page, 'subprinter');
	const picked = await pickSome(page, buildId, plate);
	const where = page.getByTestId('where-printing');
	await expect(where).toBeVisible();
	await expect(where.getByTestId('where-parts')).toContainText(
		`${picked.length} of ${plate.parts.length} parts of plate ${plate.number}`
	);
	await confirmWhere(page, 'first');
	for (const s of picked) await expect(row(page, s)).toHaveAttribute('data-s', 'Printing');
	await expect(row(page, plate.parts[0])).toHaveAttribute('data-s', 'To print');
	// A not-connected printer queues nothing.
	expect((await jobs(page, buildId)).expected).toHaveLength(0);
});

test('A whole-plate start names no parts in the Where dialog', async ({ page }) => {
	const { buildId, plate } = await setup(page, 'subwhole');
	await keepPrintedVisible(page, buildId);
	await page.goto(`/builds/${buildId}/print`);
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Group by').selectOption('plate');
	const badge = page.locator(
		`.group-head [data-testid="plate-status"][aria-label^="Plate ${plate.number} status"]`
	);
	await chooseStatus(badge, 'Printing');
	const where = page.getByTestId('where-printing');
	await expect(where).toBeVisible();
	await expect(where.getByTestId('where-parts')).toHaveCount(0);
	await confirmWhere(page, 'none');
});

test('"Not on a connected printer" starts the picked parts directly', async ({ page }) => {
	const { buildId, plate } = await setup(page, 'subnone');
	const picked = await pickSome(page, buildId, plate);
	await confirmWhere(page, 'none');
	// One start, one toast, one Undo.
	const toast = page.locator('.toasts');
	await expect(toast).toContainText(`Started ${picked.length} parts of plate ${plate.number}`);
	await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(1);
	for (const s of picked) await expect(row(page, s)).toHaveAttribute('data-s', 'Printing');
	await expect(row(page, plate.parts[0])).toHaveAttribute('data-s', 'To print');
	expect((await jobs(page, buildId)).expected).toHaveLength(0);
});
