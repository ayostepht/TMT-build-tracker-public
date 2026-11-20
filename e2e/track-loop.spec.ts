import { expect, test } from './fixtures';
import { ownerWithBuild } from './helpers';
import { chooseStatus } from './status-helpers';
import type { Page } from '@playwright/test';

// The tracking loop on a phone: one toast at a time with a thumb-sized Undo, a tappable assembly
// checklist with an "anyway?" confirm, activity rows that carry grams and notes, and the team page
// leading with what is printing. See docs/architecture.md (Build state) for the toast store.

const SHOTS = process.env.TRACK_SHOTS ?? '';
const shot = async (page: Page, name: string) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Logs the team page's Next up plate with grams and a note. Returns the plate number. */
async function logNextUpPlate(
	page: Page,
	chapterUrl: string,
	result: string,
	grams: string,
	note: string
) {
	await page.goto(chapterUrl);
	await page.waitForLoadState('networkidle');
	const card = page.getByTestId('next-up-card').first();
	const btn = card.getByRole('button', { name: /^Log a print on plate \d+$/ });
	await expect(btn).toBeVisible();
	const plate = /\d+/.exec((await btn.getAttribute('aria-label')) as string)![0];
	await btn.click();
	const sheet = page.getByRole('dialog');
	await sheet.getByRole('button', { name: result, exact: true }).click();
	await sheet.getByLabel('Filament used (g)').fill(grams);
	await sheet.getByLabel('Notes').fill(note);
	await sheet.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(sheet).toBeHidden();
	return plate;
}

test.describe('on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test('a second action replaces the toast and Undo is a 44 px target', async ({ page }) => {
		const { buildId } = await ownerWithBuild(page, 'toast-one');
		await page.goto(`/builds/${buildId}/print`);
		await page.waitForLoadState('networkidle');

		await chooseStatus(page.getByTestId('part-status').first(), 'Printed');
		await expect(page.locator('.toast')).toHaveCount(1);
		const first = await page.locator('.toast').innerText();
		await shot(page, 'toast-390-light');

		await chooseStatus(page.getByTestId('part-status').nth(1), 'Printed');
		await expect(page.locator('.toast')).toHaveCount(1);
		await expect.poll(() => page.locator('.toast').innerText()).not.toBe(first);

		const undo = page.locator('.toasts').getByRole('button', { name: 'Undo' });
		const box = (await undo.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(44);
		// the toast stays above the tab bar and below the safe area
		const bar = (await page.locator('nav.tabs[data-bottom] .tb-in').boundingBox())!;
		const toast = (await page.locator('.toast').boundingBox())!;
		expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y);
		await page.emulateMedia({ colorScheme: 'dark' });
		await shot(page, 'toast-390-dark');
	});

	test('the sheet close button is a 44 px target', async ({ page }) => {
		const { chapterUrl } = await ownerWithBuild(page, 'sheet-x');
		await page.goto(chapterUrl);
		await page.waitForLoadState('networkidle');
		await page
			.getByTestId('next-up-card')
			.first()
			.getByRole('button', { name: /^Log a print on plate \d+$/ })
			.click();
		const x = page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).first();
		const box = (await x.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	});

	test('the whole assembly row is the tap target; Mark step done asks when parts are unprinted', async ({
		page
	}) => {
		const { buildId } = await ownerWithBuild(page, 'asm-tap');
		await page.goto(`/builds/${buildId}/finish`);
		await page.waitForLoadState('networkidle');
		const step = page.locator('.astep[data-step="frame.handle"]');
		const row = step.locator('.ticks li').first();
		const label = row.locator('label');
		await label.scrollIntoViewIfNeeded();
		const lb = (await label.boundingBox())!;
		expect(lb.height).toBeGreaterThanOrEqual(44);
		const li = (await row.boundingBox())!;
		// the label spans the row, so a tap at its far right edge ticks the box
		expect(lb.width).toBeGreaterThan(li.width * 0.8);
		await page.mouse.click(lb.x + lb.width - 6, lb.y + lb.height / 2);
		await expect(label.locator('input')).toBeChecked();
		const cb = (await label.locator('input').boundingBox())!;
		expect(cb.width).toBeGreaterThanOrEqual(24);

		// the badge says it; the parts rows do not repeat it in a sentence
		await expect(step.locator('.parts')).not.toContainText("isn't printed yet");

		await step.getByRole('button', { name: 'Mark step done' }).click();
		const ask = step.getByRole('group', { name: 'Mark step done anyway?' });
		await expect(ask).toContainText(
			/\d parts? for this step (isn't|aren't) printed yet\. Mark it done anyway\?/
		);
		await expect(step).toHaveAttribute('data-done', 'false');
		await shot(page, 'assembly-confirm-390-light');
		await page.emulateMedia({ colorScheme: 'dark' });
		await shot(page, 'assembly-confirm-390-dark');

		await ask.getByRole('button', { name: 'Not yet' }).click();
		await expect(ask).toBeHidden();
		await expect(step).toHaveAttribute('data-done', 'false');

		await step.getByRole('button', { name: 'Mark step done' }).click();
		await ask.getByRole('button', { name: 'Mark done anyway' }).click();
		await expect(step).toHaveAttribute('data-done', 'true');
		await expect(ask).toBeHidden();
	});

	test('activity rows show grams and the note; links are 44 px targets', async ({ page }) => {
		const { chapterUrl, buildId } = await ownerWithBuild(page, 'act-note');
		const plate = await logNextUpPlate(page, chapterUrl, 'Failed', '34', 'warped corner');
		const long = 'The brim lifted at the left edge and the print came loose halfway up the wing';
		await logNextUpPlate(page, chapterUrl, 'Failed', '12', long);
		await page.goto(`/builds/${buildId}/activity`);
		const rows = page.locator('.activity li');
		await expect(rows.filter({ hasText: 'warped corner' })).toContainText(
			`logged a failed print of plate ${plate} · 34 g · "warped corner"`
		);
		const cut = rows.locator('.anote');
		await expect(cut).toHaveCount(1);
		await expect(cut).not.toContainText('halfway up the wing');
		await cut.click();
		await expect(cut).toContainText('halfway up the wing');
		const link = rows.locator('.alink').first();
		expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		expect((await rows.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await shot(page, 'activity-390-light');
		await page.emulateMedia({ colorScheme: 'dark' });
		await shot(page, 'activity-390-dark');
	});

	test('the team page puts Now printing before the builds list', async ({ page }) => {
		const { chapterUrl } = await ownerWithBuild(page, 'order-phone');
		await page.goto(chapterUrl);
		await page.waitForLoadState('networkidle');
		await expect(page.getByTestId('landing-now')).toBeVisible();
		const top = (await page.getByTestId('landing-now').boundingBox())!.y;
		const list = (await page.getByTestId('build-card').first().boundingBox())!.y;
		expect(top).toBeLessThan(list);
		await shot(page, 'team-390-light');
		await page.emulateMedia({ colorScheme: 'dark' });
		await shot(page, 'team-390-dark');
	});
});

test('Now printing and Next up come before the builds list in the page', async ({ page }) => {
	const { chapterUrl } = await ownerWithBuild(page, 'order');
	await page.goto(chapterUrl);
	await page.waitForLoadState('networkidle');
	const order = await page.evaluate(() => {
		const q = (s: string) => document.querySelector(s)!;
		const before = (a: Element, b: Element) =>
			!!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		return {
			now: before(q('[data-testid=landing-now]'), q('[data-testid=build-card]')),
			next: before(q('[data-testid=landing-next]'), q('[data-testid=build-card]'))
		};
	});
	expect(order).toEqual({ now: true, next: true });
	await page.setViewportSize({ width: 1440, height: 900 });
	await shot(page, 'team-1440-light');
});

test('logging a plate from the Now printing card raises no Svelte warnings', async ({ page }) => {
	// Svelte's dev-only warnings (derived_inert and friends) are compiled out of the production
	// build the suite runs on; run this spec against `npm run dev` (E2E_BASE_URL) to see them.
	const noisy: string[] = [];
	// Append the call stack to every warning, so a failure says which component read the derived.
	await page.addInitScript(() => {
		const warn = console.warn.bind(console);
		console.warn = (...args: unknown[]) => warn(...args, '\n' + new Error().stack);
	});
	const { chapterUrl } = await ownerWithBuild(page, 'inert');
	await page.goto(chapterUrl);
	await page.waitForLoadState('networkidle');
	// Collect only from here: the setup above can leave a request of the Files tab in flight.
	page.on('console', (m) => {
		if (['warning', 'error'].includes(m.type()) && /svelte|derived|inert/i.test(m.text()))
			noisy.push(m.text());
	});
	page.on('pageerror', (e) => noisy.push(String(e)));
	await chooseStatus(
		page.getByTestId('next-up-card').first().getByTestId('plate-status'),
		'Printing'
	);
	const now = page.getByTestId('landing-now-card').first();
	await expect(now).toBeVisible();
	await chooseStatus(now.getByTestId('plate-status'), 'Printed');
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('landing-now-card')).toHaveCount(0);
	await expect(page.locator('.toasts')).toContainText('Logged plate');
	await page.waitForTimeout(500);
	expect(noisy).toEqual([]);
});
