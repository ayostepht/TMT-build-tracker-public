import { expect, test } from './fixtures';
import { openNav } from './helpers';
import { withE2eDb } from './db';
import type { Page } from '@playwright/test';

// The demo sandbox: /demo starts a private, throwaway workspace with a sample build, no account.
// Restrictions are enforced on the server, so most checks here call the API directly.

const SHOTS = process.env.WAVE3_SHOTS;
const settled = (page: Page) => page.waitForLoadState('networkidle');

async function startDemo(page: Page): Promise<string> {
	await page.goto('/demo');
	await settled(page);
	await page.getByTestId('demo-start').click();
	await expect(page).toHaveURL(/\/builds\/[^/]+\/print$/, { timeout: 30_000 });
	return new URL(page.url()).pathname.split('/')[2];
}

async function shots(page: Page, name: string) {
	if (!SHOTS) return;
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const [w, h] of [
			[390, 844],
			[1440, 900]
		] as const) {
			await page.setViewportSize({ width: w, height: h });
			await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png`, fullPage: true });
		}
	}
}

test('the demo page says what you get and starts a demo with tracking first', async ({ page }) => {
	await page.goto('/demo');
	await settled(page);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Track a sample chair build');
	await expect(page.locator('main')).toContainText('24 hours');
	await shots(page, 'demo-page');
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ colorScheme: 'light' });

	const buildId = await startDemo(page);
	await settled(page);
	await expect(page.getByTestId('demo-banner')).toContainText("You're in a demo");
	await expect(page.getByTestId('demo-banner')).toContainText(/deleted in \d+ hours?/);
	await expect(page.getByTestId('demo-sign-in')).toHaveAttribute('href', '/login');
	// the sample build is under way: a plate is printing and parts are printed
	await expect(page.locator('main')).toContainText('Sample chair');
	await expect(page.locator('main')).toContainText(/Printing/);
	await expect(page.locator('main')).toContainText(/Printed/);
	await shots(page, 'demo-build');

	// nav: the gallery link is there, and the demo has no team or account controls
	await page.setViewportSize({ width: 1280, height: 900 });
	await openNav(page);
	await expect(page.getByTestId('nav-gallery')).toHaveAttribute('href', '/gallery');
	await expect(page.getByRole('link', { name: 'Create a chapter' })).toHaveCount(0);

	// everything else works: mark a part
	const res = await page.request.get(`/api/builds/${buildId}/photos`);
	expect(res.status()).toBe(200);
});

test('the server refuses uploads, printers, teams, invitations and export to a demo', async ({
	page
}) => {
	const buildId = await startDemo(page);
	const origin = new URL(page.url()).origin;
	const headers = { origin };
	const statuses: Record<string, number> = {};
	const post = async (name: string, path: string, data: unknown = {}, method = 'post') => {
		const res = await page.request.fetch(path, {
			method,
			headers,
			data: data as never
		});
		statuses[name] = res.status();
		return res;
	};
	await post('photo', `/api/builds/${buildId}/photos`, { x: 1 });
	await post('plates', `/api/builds/${buildId}/plates/upload?name=a.3mf`, 'PK');
	await post('printer', '/api/printers', { organizationId: 'x', name: 'p' });
	await post('printer-test', '/api/printers/test', { organizationId: 'x' });
	await post('camera-test', '/api/printers/camera-test', { organizationId: 'x' });
	await post('guide', '/api/templates/x/guide/pages/1', 'x');
	await post('model', '/api/templates/x/model', 'x');
	await post('geometry', '/api/templates/x/print-geometry', 'x');
	await post('snapshot', '/api/designs/x/snapshot', 'x', 'put');
	await post('org', '/api/auth/organization/create', { name: 'My team', slug: 'my-team' });
	const exp = await page.request.get('/api/account/export');
	statuses.export = exp.status();
	for (const [name, status] of Object.entries(statuses))
		expect([401, 403], `${name} -> ${status}`).toContain(status);
	for (const name of [
		'photo',
		'plates',
		'printer',
		'printer-test',
		'camera-test',
		'snapshot',
		'org',
		'export'
	])
		expect(statuses[name], name).toBe(403);
	// a team really was not created
	await withE2eDb(async (sql) => {
		const rows = await sql`select 1 from organization where slug = 'my-team'`;
		expect(rows).toHaveLength(0);
	});
	// the account page is not for demos
	await page.goto('/account');
	await expect(page).toHaveURL(/\/workspace|\/teams\//);
});

test('signing out of the demo deletes it at once', async ({ page }) => {
	const buildId = await startDemo(page);
	await settled(page);
	const count = () =>
		withE2eDb(async (sql) => {
			const [r] = await sql<
				{ n: number }[]
			>`select count(*)::int as n from builds where id = ${buildId}`;
			return r.n;
		});
	expect(await count()).toBe(1);
	await openNav(page);
	await page.getByTestId('account-menu').click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login\?notice=demo-ended/);
	await expect(page.getByText('The demo was deleted.')).toBeVisible();
	expect(await count()).toBe(0);
	// the old session is gone
	await page.goto('/workspace');
	await expect(page).toHaveURL(/\/login/);
});

test('a visitor with a demo can open the login page and sign in for real', async ({ page }) => {
	await startDemo(page);
	await page.goto('/login');
	await settled(page);
	await expect(page.getByText(/You are in the demo/)).toBeVisible();
	await expect(page.getByTestId('sign-in-google')).toBeVisible();
});
