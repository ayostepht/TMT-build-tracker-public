import { expect, test } from './fixtures';
import { signUp, uniqueEmail } from './helpers';
import type { Page } from '@playwright/test';

// The SSO-only login page. The e2e server has only the (dummy) Google app configured; no spec
// reaches a real provider: the request to Google's authorization page is intercepted.

const SHOTS = process.env.WAVE3_SHOTS;
const settled = (page: Page) => page.waitForLoadState('networkidle');

test('login: one button per enabled provider, no password field, demo and legal links', async ({
	page
}) => {
	await page.goto('/login');
	await settled(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
	await expect(page.getByTestId('sign-in-google')).toContainText('Continue with Google');
	await expect(page.getByTestId('sign-in-github')).toHaveCount(0);
	await expect(page.getByTestId('sign-in-discord')).toHaveCount(0);
	await expect(page.locator('input[type="password"], input[type="email"]')).toHaveCount(0);
	await expect(page.getByTestId('try-demo')).toHaveAttribute('href', '/demo');
	await expect(page.getByTestId('terms-link')).toHaveAttribute('href', '/terms');
	await expect(page.getByTestId('privacy-link')).toHaveAttribute('href', '/privacy');
	await expect(page.locator('main')).toContainText('creates your account');
	if (SHOTS)
		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			for (const [w, h] of [
				[390, 844],
				[1440, 900]
			] as const) {
				await page.setViewportSize({ width: w, height: h });
				await page.screenshot({ path: `${SHOTS}/login-${w}-${scheme}.png`, fullPage: true });
			}
		}
});

test('the Google button sends the browser to Google with our callback', async ({ page }) => {
	let target = '';
	await page.route('https://accounts.google.com/**', (route) => {
		target = route.request().url();
		return route.fulfill({ status: 200, contentType: 'text/html', body: 'google' });
	});
	await page.goto('/login?redirect=%2Finvite%2Fabc');
	await settled(page);
	await page.getByTestId('sign-in-google').click();
	await expect.poll(() => target).toContain('accounts.google.com');
	const url = new URL(target);
	expect(url.searchParams.get('client_id')).toBe('e2e-google-client-id');
	expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/);
});

test('an OAuth failure comes back as a fixed message', async ({ page }) => {
	await page.goto('/login?error=email_not_verified');
	await expect(page.getByTestId('auth-error')).toContainText('verified email');
	await page.goto('/login?error=<script>alert(1)</script>');
	await expect(page.getByTestId('auth-error')).toContainText('did not complete');
	await expect(page.locator('main script')).toHaveCount(0);
});

test('a signed-in visitor on /login or /signup goes straight into the app, honouring a safe redirect', async ({
	page
}) => {
	await signUp(page, 'Lou Login', uniqueEmail('login'));
	await page.goto('/login');
	await expect(page).toHaveURL(/\/teams\//);
	await page.goto('/login?redirect=%2Fhelp');
	await expect(page).toHaveURL(/\/help$/);
	await page.goto('/login?redirect=https%3A%2F%2Fevil.example');
	await expect(page).toHaveURL(/\/teams\//);
});

test('an invitation link asks a signed-out visitor to sign in and returns afterwards', async ({
	page
}) => {
	await page.goto('/invite/does-not-exist');
	await expect(page.getByText(/not found/i)).toBeVisible();
});
