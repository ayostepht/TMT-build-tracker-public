import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import {
	createBuild,
	createChapter,
	invite,
	joinViaInvite,
	signInAsAdmin,
	signUp,
	uniqueEmail
} from './helpers';

// Own users only: nothing shared with other specs is touched.
const SHOTS = process.env.ACCOUNT_SHOTS;

test('export my data, then delete my account', async ({ page, browser }) => {
	const adminCtx = await browser.newContext({
		extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' }
	});
	await signInAsAdmin(await adminCtx.newPage());
	await adminCtx.close();
	const email = uniqueEmail('acct');
	await signUp(page, 'Ada Account', email);
	await createBuild(page, 'Throwaway chair', null);

	await page.getByTestId('account-menu').click();
	await page.getByTestId('account-link').click();
	await expect(page).toHaveURL(/\/account$/);
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('heading', { level: 1, name: 'Ada Account' })).toBeVisible();

	if (SHOTS) {
		for (const [w, h] of [
			[390, 844],
			[1440, 900]
		] as const) {
			await page.setViewportSize({ width: w, height: h });
			await page.screenshot({ path: `${SHOTS}/account-${w}.png`, fullPage: true });
		}
	}

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('export-data').click()
	]);
	const path = await download.path();
	const data = JSON.parse(readFileSync(path, 'utf8'));
	expect(data.profile.email).toBe(email);
	expect(data.builds).toHaveLength(1);
	expect(data.builds[0].build.name).toBe('Throwaway chair');

	expect((await page.request.get('/api/account/users')).status()).toBe(403);
	const openDelete = page.getByTestId('delete-account-open');
	await openDelete.click();
	const dlg = page.getByTestId('delete-account-dialog');
	await expect(dlg).toBeVisible();
	// Destructive dialog: Cancel has focus, so a stray Enter cancels; the account stays.
	await expect(dlg.getByRole('button', { name: 'Cancel' }).first()).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(dlg).toHaveCount(0);
	await expect(openDelete).toBeFocused();
	await expect(page).toHaveURL(/\/account/);
	await openDelete.click();
	await expect(dlg).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/account-dialog.png` });
	const confirm = page.getByTestId('delete-account-confirm');
	await expect(confirm).toBeDisabled();
	// A wrong address keeps the button off; the right one turns it on.
	await page.getByTestId('delete-confirm-email').fill('someone-else@example.com');
	await expect(confirm).toBeDisabled();
	await page.getByTestId('delete-confirm-email').fill(email);
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(page).toHaveURL(/\/login\?notice=deleted/);
	await expect(page.getByText('Your account was deleted.')).toBeVisible();

	// the account is gone: signing in with the same address starts a fresh, empty account
	await signUp(page, 'Ada Again', email);
	await page.goto('/builds');
	await page.waitForLoadState('networkidle');
	await expect(page.getByText('Throwaway chair')).toHaveCount(0);
});

test('the only owner of a chapter with other members cannot delete the account', async ({
	page,
	browser
}) => {
	await signUp(page, 'Olive Owner', uniqueEmail('sole'));
	await createChapter(page, `Sole ${Date.now().toString(36)}`);
	const joinerEmail = uniqueEmail('joiner');
	const link = await invite(page, joinerEmail, 'viewer');
	const joiner = await joinViaInvite(browser, link, 'Jo Joiner', joinerEmail);
	await joiner.context.close();

	await page.goto('/account');
	await page.waitForLoadState('networkidle');
	await expect(page.getByTestId('delete-blocked')).toContainText('Make someone else an owner of');
	await page.getByTestId('delete-account-open').click();
	await expect(page.getByTestId('delete-account-confirm')).toBeDisabled();
});
