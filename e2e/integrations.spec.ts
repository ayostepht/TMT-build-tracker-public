import { expect, test } from './fixtures';
import { invite, joinViaInvite, ownerWithBuild, uniqueEmail } from './helpers';
import { gotoIntegrations } from './integrations-helpers';

/**
 * The Integrations page. A printer is reached through an OctoEverywhere link or is not connected at
 * all. Link printers are saved DISABLED and never tested: a link is a made-up name that must never
 * be looked up or dialled by the suite.
 */
const LINK = 'https://shared-e2eintegr12345678.octoeverywhere.com';

const CARDS = ['octoeverywhere', 'manual'];

test('the chooser renders every option from the options endpoint with its two labels', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { chapterUrl } = await ownerWithBuild(page, 'ig-chooser');
	await gotoIntegrations(page, chapterUrl);
	// No printers yet: a plain line, and nothing about addresses on your own network or Spoolman.
	await expect(page.getByTestId('printers-none')).toBeVisible();
	await expect(page.getByTestId('hosted-note')).toHaveCount(0);
	await expect(page.getByTestId('team-spoolman')).toHaveCount(0);
	await expect(page.getByTestId('integrations-unavailable')).toHaveCount(0);
	await page.getByTestId('add-printer').click();
	const chooser = page.getByTestId('printer-chooser');
	await expect(chooser).toBeVisible();
	await expect(chooser.getByRole('heading', { level: 4 })).toHaveText([
		'Through OctoEverywhere',
		'Not connected'
	]);
	for (const id of CARDS) await expect(page.getByTestId(`option-${id}`)).toBeVisible();
	await expect(chooser.locator('button[data-testid^="option-"]')).toHaveCount(CARDS.length);

	// No row is tagged Experimental (the link form tags the unverified printer types itself).
	await expect(chooser.getByTestId('experimental-tag')).toHaveCount(0);
	await expect(chooser.getByTestId('experimental-note')).toHaveCount(0);
	for (const id of CARDS) {
		const row = page.getByTestId(`option-${id}`);
		await expect(row).toBeEnabled();
		await expect(row.getByTestId('hosted-label')).toHaveCount(0);
		await expect(row.getByTestId('verified-label')).toHaveCount(0);
	}
	// Short descriptions.
	await expect(page.getByTestId('option-octoeverywhere')).toContainText(
		'For Elegoo, Klipper or OctoPrint, from anywhere'
	);
	await expect(page.getByTestId('option-manual')).toContainText('A name only, for logging by hand');
	// Compact rows: about 48 px on desktop, at most 64 px on the phone (44 px minimum).
	const heights = async () =>
		Promise.all(
			CARDS.map(async (id) => (await page.getByTestId(`option-${id}`).boundingBox())!.height)
		);
	for (const h of await heights()) {
		expect(h).toBeGreaterThanOrEqual(44);
		expect(h).toBeLessThanOrEqual(64);
	}
	await page.screenshot({
		path: 'data/r49-shots-integrations/chooser-390-light.png',
		fullPage: true
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const h of await heights()) {
		expect(h).toBeGreaterThanOrEqual(44);
		expect(h).toBeLessThanOrEqual(52);
	}
	// The whole chooser fits one desktop screen.
	const box = (await chooser.boundingBox())!;
	expect(box.y + box.height).toBeLessThanOrEqual(900);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.getByRole('button', { name: 'Cancel' }).first().click();
	await expect(chooser).toHaveCount(0);
});

test('choosing an option shows only its fields and its setup steps', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { chapterUrl } = await ownerWithBuild(page, 'ig-forms');
	await gotoIntegrations(page, chapterUrl);
	const has = async (...ids: string[]) => {
		for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(1);
	};
	const hasNot = async (...ids: string[]) => {
		for (const id of ids) await expect(page.getByTestId(id), id).toHaveCount(0);
	};
	const steps = async (guide: RegExp) => {
		const n = await page.getByTestId('pf-steps').locator('li').count();
		expect(n).toBeGreaterThanOrEqual(3);
		expect(n).toBeLessThanOrEqual(5);
		await expect(page.getByTestId('pf-guide')).toHaveAttribute(
			'href',
			/^https:\/\/github\.com\/.+\/docs\/guides\/printers\.md#/
		);
		await expect(page.getByTestId('pf-guide')).toHaveAttribute('href', guide);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390
		);
	};
	const open = async (id: string) => {
		await page.getByTestId('add-printer').click();
		await page.getByTestId(`option-${id}`).click();
		await expect(page.getByTestId('printer-form')).toBeVisible();
	};
	const cancel = async () => {
		await page.getByTestId('printer-form').getByRole('button', { name: 'Cancel' }).click();
		await page.getByTestId('printer-chooser').getByRole('button', { name: 'Cancel' }).click();
	};

	// OctoEverywhere: one card, a "Printer type" select inside, no address or port.
	await open('octoeverywhere');
	const type = page.getByTestId('pf-link-type');
	await expect(type.locator('option')).toHaveText(['Elegoo', 'Klipper', 'OctoPrint']);
	await has('pf-shareLink', 'pf-camera-via-link');
	await hasNot('pf-host', 'pf-port', 'pf-camera-url', 'pf-discover', 'pf-apiKey', 'pf-mainboardId');
	await expect(page.getByTestId('pf-shareLink')).toHaveAttribute('required', '');
	await steps(/#through-an-octoeverywhere-shared-link$/);
	await page.screenshot({
		path: 'data/r49-shots-integrations/form-octoeverywhere-elegoo-390-light.png',
		fullPage: true
	});
	await hasNot('pf-experimental'); // Elegoo has been run on a real printer
	await type.selectOption({ label: 'Klipper' });
	await has('pf-shareLink', 'pf-apiKey', 'pf-experimental');
	await expect(page.getByTestId('pf-experimental')).toContainText('Experimental');
	await expect(page.getByTestId('pf-experimental').getByRole('link')).toHaveAttribute(
		'href',
		/\/issues\/new\?template=printer-report\.yml$/
	);
	await expect(page.getByTestId('pf-apiKey')).not.toHaveAttribute('required', '');
	await steps(/#klipper-moonraker-through-an-octoeverywhere-shared-link$/);
	await page.screenshot({
		path: 'data/r49-shots-integrations/form-octoeverywhere-klipper-390-light.png',
		fullPage: true
	});
	await type.selectOption({ label: 'OctoPrint' });
	await has('pf-experimental');
	await expect(page.getByTestId('pf-apiKey')).toHaveAttribute('required', '');
	await steps(/#octoprint-through-an-octoeverywhere-shared-link$/);
	await hasNot('pf-host');
	await cancel();

	await open('manual');
	await hasNot(
		'pf-host',
		'pf-port',
		'pf-test',
		'pf-camera',
		'pf-shareLink',
		'pf-apiKey',
		'pf-kind',
		'pf-enabled'
	);
	await expect(page.getByLabel('Model (optional)')).toBeVisible();
	await steps(/#a-printer-that-is-not-connected$/);
	await page.screenshot({
		path: 'data/r49-shots-integrations/form-manual-390-light.png',
		fullPage: true
	});
	await cancel();
});

test('a link printer of each type and a manual printer are created through the UI', async ({
	page
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 390, height: 844 });
	const { chapterUrl } = await ownerWithBuild(page, 'ig-create');
	await gotoIntegrations(page, chapterUrl);

	// Automatic logging needs a connected printer: until then, one muted line.
	await expect(page.getByTestId('autolog-hint')).toBeVisible();
	await expect(page.getByTestId('autolog')).toHaveCount(0);

	// Manual printer: a name is enough.
	await page.getByTestId('add-printer').click();
	await page.getByTestId('option-manual').click();
	await page.getByLabel('Name', { exact: true }).fill('Garage printer');
	await page.getByTestId('pf-save').click();
	const rows = page.getByTestId('printer-row');
	await expect(rows).toHaveCount(1);
	await expect(rows.first().getByTestId('row-connection')).toHaveText('Not connected');
	await expect(rows.first().getByTestId('row-state')).toHaveText('Logged by hand');
	await expect(rows.first().getByTestId('toggle-printer')).toHaveCount(0);
	await expect(page.getByTestId('autolog-hint')).toBeVisible(); // still no connected printer

	// One link printer per type, saved disabled (never dialled).
	for (const [type, name, key] of [
		['Elegoo', 'Link Elegoo', ''],
		['Klipper', 'Link Klipper', 'KEY'],
		['OctoPrint', 'Link OctoPrint', 'KEY']
	]) {
		await page.getByTestId('add-printer').click();
		await page.getByTestId('option-octoeverywhere').click();
		await page.getByTestId('pf-link-type').selectOption({ label: type });
		await page.getByLabel('Name', { exact: true }).fill(name);
		await page.getByTestId('pf-shareLink').fill(LINK);
		if (key) await page.getByTestId('pf-apiKey').fill(key);
		await page.getByTestId('pf-enabled').uncheck();
		await page.getByTestId('pf-save').click();
		await expect(page.getByTestId('printer-form')).toHaveCount(0);
		await expect(rows.filter({ hasText: name })).toContainText(`${type} · OctoEverywhere link`);
		await expect(rows.filter({ hasText: name }).getByTestId('row-state')).toHaveText(
			'Monitoring stopped'
		);
	}
	await expect(rows).toHaveCount(4);
	// A connected printer exists now: the setting appears.
	await expect(page.getByTestId('autolog')).toBeVisible();
	await expect(page.getByTestId('autolog-hint')).toHaveCount(0);

	// Secrets are never rendered back or returned.
	const org = (
		(await (await page.request.get('/api/auth/organization/list')).json()) as {
			id: string;
			metadata?: { personal?: boolean };
		}[]
	).find((o) => !o.metadata?.personal)!.id;
	const raw = await (await page.request.get(`/api/printers?org=${org}`)).text();
	expect(raw).not.toMatch(/shared-|octoeverywhere\.com|KEY/);
	await page.getByTestId('edit-printer').nth(1).click();
	await expect(page.getByTestId('pf-shareLink')).toHaveValue('');
	await expect(page.getByTestId('pf-shareLink')).toHaveAttribute('placeholder', /Saved/);
	await expect(page.getByTestId('pf-link-type')).toHaveCount(0); // the printer type is fixed once saved
	expect(await page.content()).not.toContain('e2eintegr');
	await page.getByTestId('printer-form').getByRole('button', { name: 'Cancel' }).click();

	// The Printers view: no add form, a Manage link per card, the manual printer is neutral.
	await page.goto(`${chapterUrl}/printers`);
	await expect(page.getByTestId('printer-card')).toHaveCount(4);
	await expect(page.getByTestId('add-printer')).toHaveCount(0);
	await expect(page.getByTestId('printer-form')).toHaveCount(0);
	await expect(page.getByTestId('printer-manage')).toHaveCount(4);
	const manual = page.getByTestId('printer-card').filter({ hasText: 'Garage printer' });
	await expect(manual.getByTestId('printer-state')).toHaveText('Not connected');
	await expect(manual.getByTestId('printer-manual')).toBeVisible();
	await expect(manual.getByTestId('printer-progress')).toHaveCount(0);
	await expect(manual).not.toContainText(/offline|connecting/i);
	await expect(manual.getByTestId('printer-state')).not.toHaveClass(/ds-badge--(bad|warn)/);
	await page.getByTestId('printers-manage').click();
	await expect(page).toHaveURL(/\/integrations$/);

	// Remove through the shared dialog.
	await page.getByTestId('remove-printer').first().click();
	await page.getByTestId('ask-confirm').click();
	await expect(rows).toHaveCount(3);
});

test('a viewer sees the printers but no add, edit or remove controls', async ({
	page,
	browser
}) => {
	test.setTimeout(120_000);
	const { chapterUrl } = await ownerWithBuild(page, 'ig-viewer');
	await gotoIntegrations(page, chapterUrl);
	await page.getByTestId('add-printer').click();
	await page.getByTestId('option-manual').click();
	await page.getByLabel('Name', { exact: true }).fill('Garage printer');
	await page.getByTestId('pf-save').click();
	await expect(page.getByTestId('printer-row')).toHaveCount(1);
	await page.goto(chapterUrl);
	const viewerEmail = uniqueEmail('ig-viewer');
	const link = await invite(page, viewerEmail, 'viewer');
	const { context, page: v } = await joinViaInvite(browser, link, 'Vera Viewer', viewerEmail);
	await v.goto(`${new URL(chapterUrl).pathname}/integrations`);
	await expect(v.getByTestId('printer-row')).toHaveCount(1);
	await expect(v.getByTestId('printer-row')).toContainText('Garage printer');
	for (const id of ['add-printer', 'edit-printer', 'remove-printer', 'toggle-printer'])
		await expect(v.getByTestId(id), id).toHaveCount(0);
	await v.goto(`${new URL(chapterUrl).pathname}/printers`);
	await expect(v.getByTestId('printer-card')).toHaveCount(1);
	await expect(v.getByTestId('printer-manage')).toHaveCount(0);
	await expect(v.getByTestId('printers-manage')).toHaveCount(0);
	await context.close();
});

test('the Printers view: empty state with a way to Integrations; viewers are told to ask', async ({
	page,
	browser
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 390, height: 844 });
	const { chapterUrl } = await ownerWithBuild(page, 'ig-empty');
	await page.goto(`${chapterUrl}/printers`);
	await expect(page.getByTestId('printers-empty')).toContainText('No printers yet.');
	await expect(page.getByTestId('printers-manage')).toHaveText('Add or manage printers');
	await expect(page.getByTestId('add-printer')).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: 'data/r49-shots-integrations/printers-empty-390-light.png',
		fullPage: true
	});
	await page.goto(chapterUrl);
	const viewerEmail = uniqueEmail('ig-empty');
	const link = await invite(page, viewerEmail, 'viewer');
	const { context, page: v } = await joinViaInvite(browser, link, 'Vera', viewerEmail);
	await v.goto(`${new URL(chapterUrl).pathname}/printers`);
	await expect(v.getByTestId('printers-empty')).toContainText('Ask a chapter owner or editor');
	await expect(v.getByTestId('printers-manage')).toHaveCount(0);
	await context.close();
});
