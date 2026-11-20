import { expect, newClientContext, test } from './fixtures';
import { createChapter, invite, signUp, startBuild, toSetupStep, uniqueEmail } from './helpers';

// Fixes from the first-time-maker journey audit: invite dead ends, member errors, "Finish setup",
// the wizard's phone layout, the demo start card and the feedback link.

const SHOTS = process.env.JOURNEY_SHOTS;
const PHONE = { width: 390, height: 844 };

async function shot(page: import('@playwright/test').Page, name: string) {
	if (!SHOTS) return;
	for (const [w, h] of [
		[390, 844],
		[1440, 900]
	] as const) {
		await page.setViewportSize({ width: w, height: h });
		await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true });
	}
	await page.setViewportSize(PHONE);
}

test('invite page: wrong account can switch account (masked address); accepted shows "Go to the team"; member errors speak of teams', async ({
	page,
	browser
}) => {
	test.setTimeout(120_000);
	const ownerEmail = uniqueEmail('jf-owner');
	await signUp(page, 'Olive Owner', ownerEmail);
	await createChapter(page, `Journey ${Date.now().toString(36)}`);
	const guestEmail = `dana.${Date.now().toString(36)}@example.com`;
	const link = await invite(page, guestEmail, 'editor');
	const path = new URL(link).pathname;

	// Why the email is asked for.
	await expect(page.getByText('Nothing is emailed; you send the link yourself.')).toBeVisible();
	await shot(page, 'members-invite');

	// A different account opens the link.
	const other = await newClientContext(browser);
	const op = await other.newPage();
	const otherEmail = uniqueEmail('jf-other');
	await signUp(op, 'Otto Other', otherEmail, path);
	await expect(op.getByTestId('invite-switch-account')).toBeVisible();
	const masked = op.getByTestId('invite-masked-email');
	await expect(masked).toHaveText(`d•••@example.com`);
	const html = await op.content();
	expect(html).not.toContain(guestEmail);
	await expect(op.getByRole('link', { name: 'Go to my builds' })).toBeVisible();
	await op.setViewportSize(PHONE);
	await shot(op, 'invite-wrong-account');
	await op.getByTestId('invite-switch-account').click();
	await expect(op).toHaveURL(new RegExp(`/login\\?redirect=${encodeURIComponent(path)}`));
	await other.close();

	// The invited account accepts; the used link then offers the team.
	const guest = await newClientContext(browser);
	const gp = await guest.newPage();
	await signUp(gp, 'Dana Guest', guestEmail, path);
	await gp.getByRole('button', { name: 'Accept' }).click();
	await expect(gp).toHaveURL(/\/teams\//);
	await gp.goto(path);
	await expect(gp.getByText('This invitation is accepted.')).toBeVisible();
	await gp.setViewportSize(PHONE);
	await shot(gp, 'invite-used');
	await gp.getByTestId('invite-go-team').click();
	await expect(gp).toHaveURL(/\/teams\/[^/]+$/);
	await guest.close();

	// Owner: inviting a member again, and demoting the only owner, say "team" not "organization".
	await page.goto(
		page.url().replace(/\/teams\/[^/]+.*/, (m) => m.split('/').slice(0, 3).join('/'))
	);
	await page.getByRole('link', { name: 'Members', exact: true }).click();
	await page.waitForLoadState('networkidle');
	const form = page.locator('form[action="?/invite"]');
	await form.getByLabel('Email').fill(guestEmail);
	await form.getByRole('button', { name: 'Create invite link' }).click();
	const alert = page.getByRole('alert').first();
	await expect(alert).toHaveText('That person is already on this team.');

	await page.getByLabel('Role of Olive Owner').selectOption('editor');
	await expect(page.getByRole('alert').first()).toHaveText(
		'A team needs at least one owner. Make someone else an owner first.'
	);
	expect(await page.content()).not.toMatch(/organization/i);
	await shot(page, 'members-error');
});

test('"Finish setup" clears the setup state; step 3 does not overflow at 390 px', async ({
	page
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize(PHONE);
	await signUp(page, 'Wendy Finish', uniqueEmail('jf-wizard'));
	const id = await startBuild(page, 'Finish chair');
	await toSetupStep(page, 3);
	await expect(page.getByTestId('design-workspace')).toBeVisible();
	await page.waitForLoadState('networkidle');
	// The page and the sticky Back/Continue bar stay within the phone's width on every Colors tab.
	for (const tab of ['Colors', 'Palettes', 'Parts']) {
		await page.getByRole('tab', { name: tab }).click();
		const m = await page.evaluate(() => ({
			vw: document.documentElement.clientWidth,
			sw: document.documentElement.scrollWidth,
			navRight: document
				.querySelector('[data-testid="wizard-next"]')!
				.parentElement!.getBoundingClientRect().right
		}));
		expect(m.sw, `${tab} page width`).toBeLessThanOrEqual(m.vw);
		expect(m.navRight, `${tab} bar right edge`).toBeLessThanOrEqual(m.vw);
	}
	await page.getByRole('tab', { name: 'Colors' }).click();
	await shot(page, 'wizard-step3');
	for (const n of [4, 5]) {
		await page.getByTestId('wizard-next').click();
		await expect(page).toHaveURL(new RegExp(`step=${n}`));
		await page.waitForLoadState('networkidle');
	}
	await page.getByTestId('wizard-done').click();
	await expect(page.getByTestId('setup-done')).toBeVisible();
	await shot(page, 'wizard-done');
	// Leave by URL, not by "Open the build".
	await page.goto(`/builds/${id}`);
	await expect(page.getByTestId('header-kpis')).toBeVisible();
	await expect(page.getByTestId('continue-setup')).toHaveCount(0);
});

test('a second team with the same name needs a second press', async ({ page }) => {
	await signUp(page, 'Dora Dupe', uniqueEmail('jf-dupe'));
	const name = `Same ${Date.now().toString(36)}`;
	await createChapter(page, name);
	await page.goto('/onboarding');
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Team name').fill(name);
	await page.getByRole('button', { name: 'Create team' }).click();
	await expect(page.getByTestId('team-duplicate')).toContainText(
		`You already have a team called ${name}`
	);
	await shot(page, 'create-team-duplicate');
	await page.getByRole('button', { name: 'Create anyway' }).click();
	await expect(page).toHaveURL(/\/teams\//);
});

test('the demo start button is in the first phone viewport', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto('/demo');
	await page.waitForLoadState('networkidle');
	const box = await page.getByTestId('demo-start').boundingBox();
	expect(box).not.toBeNull();
	expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
	expect(box!.width).toBeGreaterThan(PHONE.width - 80);
	await shot(page, 'demo');
});

test('the feedback link is in the site footer and the app footer', async ({ page }) => {
	await page.goto('/');
	const site = page.getByTestId('footer-feedback');
	await expect(site).toHaveAttribute('href', /github\.com\/.+\/issues\/new/);
	await expect(site).toHaveAttribute('target', '_blank');
	await expect(site).toHaveAttribute('rel', /noopener/);
	await signUp(page, 'Fay Feedback', uniqueEmail('jf-feedback'));
	const app = page.getByTestId('app-footer').getByTestId('footer-feedback');
	await expect(app).toHaveAttribute('href', /github\.com\/.+\/issues\/new/);
	await expect(app).toHaveAttribute('rel', /noopener/);
	await shot(page, 'app-footer');
});
