import { expect, test } from '@playwright/test';

// The e2e server enables Google only (playwright.config.ts): page text must not name other providers.
test('the home page and the sign-in page name only the enabled provider', async ({ page }) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await expect(page.locator('body')).not.toContainText(/Discord/);
	await page.goto('/login');
	await expect(page.getByTestId('sign-in-google')).toBeVisible();
	await expect(page.locator('body')).not.toContainText(/Discord/);
});

test('the privacy page names the enabled provider', async ({ page }) => {
	await page.goto('/privacy');
	await expect(page.locator('main')).toContainText('You sign in with Google.');
});

// Optional screenshots: SHOT_DIR=/some/dir npx playwright test providers-copy
test('screenshots of home and login', async ({ page }) => {
	const dir = process.env.SHOT_DIR;
	test.skip(!dir, 'set SHOT_DIR to write screenshots');
	await page.emulateMedia({ colorScheme: 'light' });
	for (const [w, h] of [
		[1440, 900],
		[390, 844]
	]) {
		await page.setViewportSize({ width: w, height: h });
		for (const [name, path] of [
			['home', '/'],
			['login', '/login']
		]) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			await page.screenshot({ path: `${dir}/${name}-${w}-light.png` });
		}
	}
});
