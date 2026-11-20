import { expect, test } from './fixtures';
import { openNav, signUp, uniqueEmail } from './helpers';
import { withE2eDb } from './db';
import type { Page } from '@playwright/test';

// A way back to the public home page from the app and from a demo.

const SHOTS = process.env.WAYHOME_SHOTS;
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

test('signed in: the home page is reachable from the footer and the menu, and offers your builds', async ({
	page
}) => {
	await signUp(page, 'Hana Home', uniqueEmail('home'));
	await settled(page);
	await expect(page.getByTestId('footer-home')).toHaveAttribute('href', '/');
	await page.getByTestId('footer-home').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByTestId('home-open-builds')).toBeVisible();
	await expect(page.getByTestId('site-open-builds')).toHaveText('Open your builds');
	await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
	await shots(page, 'home-signed-in');
	await page.getByTestId('home-open-builds').click();
	await expect(page).toHaveURL(/\/teams\//);

	await openNav(page);
	await page.getByTestId('account-menu').click();
	await expect(page.getByTestId('menu-home')).toBeVisible();
	if (SHOTS)
		for (const [w, h] of [
			[390, 844],
			[1440, 900]
		] as const) {
			await page.emulateMedia({ colorScheme: 'light' });
			await page.setViewportSize({ width: w, height: h });
			await page.goto('/workspace');
			await settled(page);
			await openNav(page);
			if ((await page.getByTestId('account-menu').getAttribute('aria-expanded')) !== 'true')
				await page.getByTestId('account-menu').click();
			await expect(page.getByTestId('menu-home')).toBeVisible();
			await page.screenshot({ path: `${SHOTS}/app-menu-open-${w}-light.png` });
		}
	await page.getByTestId('menu-home').click();
	await expect(page).toHaveURL(/\/$/);
});

test('signing out of a real account lands on the home page, signed out', async ({ page }) => {
	await signUp(page, 'Sid Out', uniqueEmail('signout'));
	await settled(page);
	await openNav(page);
	await page.getByTestId('account-menu').click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByTestId('home-notice')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
});

test('in a demo: home is reachable, says "Back to the demo", and leaving deletes the demo', async ({
	page
}) => {
	const buildId = await startDemo(page);
	await settled(page);
	await shots(page, 'demo-banner');
	await expect(page.getByTestId('footer-home')).toBeVisible();

	await page.getByTestId('footer-home').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByTestId('site-open-builds')).toHaveText('Back to the demo');
	await shots(page, 'home-demo');
	await page.getByTestId('home-open-builds').click();
	await expect(page).toHaveURL(/\/builds\/|\/teams\//);

	const count = () =>
		withE2eDb(async (sql) => {
			const [r] = await sql<
				{ n: number }[]
			>`select count(*)::int as n from builds where id = ${buildId}`;
			return r.n;
		});
	// leaving asks first; "Keep it" changes nothing
	await page.getByTestId('demo-leave').click();
	await shots(page, 'demo-leave-confirm');
	await page.getByRole('button', { name: 'Keep it' }).click();
	await expect(page.getByTestId('demo-leave')).toBeVisible();
	expect(await count()).toBe(1);

	await page.getByTestId('demo-leave').click();
	await page.getByTestId('demo-leave-confirm').click();
	await expect(page).toHaveURL(/\/\?notice=demo-ended/);
	await expect(page.getByTestId('home-notice')).toHaveText('The demo was deleted.');
	expect(await count()).toBe(0);
	await page.goto('/workspace');
	await expect(page).toHaveURL(/\/login/);
});

test('a signed-out visitor opening the installed app start page is sent to sign in', async ({
	page
}) => {
	await page.goto('/workspace');
	await expect(page).toHaveURL(/\/login/);
});

test('every link to the demo does a full page load (the demo page needs its own CSP)', async ({
	page
}) => {
	await page.goto('/');
	const home = page.locator('a[href="/demo"]');
	expect(await home.count()).toBeGreaterThanOrEqual(3);
	for (const el of await home.all()) await expect(el).toHaveAttribute('data-sveltekit-reload', '');
	await page.goto('/login');
	await expect(page.getByTestId('try-demo')).toHaveAttribute('data-sveltekit-reload', '');
});
