import { expect, test } from './fixtures';
import { openNav, signUp, uniqueEmail } from './helpers';
import type { Page } from '@playwright/test';

// Signing out re-runs the current page's load (invalidateAll); it must end on the home page,
// never on an error page. Unauthenticated form posts answer 401, not 500.

async function signOut(page: Page) {
	await openNav(page);
	await page.getByTestId('account-menu').click();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}

for (const path of ['/account', '/studio']) {
	test(`signing out while on ${path} lands on the home page with no error page`, async ({
		page
	}) => {
		await signUp(page, 'Guard Tester', uniqueEmail('so'));
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		await signOut(page);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect(page.getByText(/Internal Error|500/)).toHaveCount(0);
	});
}

test('an unauthenticated POST to the members actions answers 401, not 500', async ({
	request,
	baseURL
}) => {
	const origin = new URL(baseURL as string).origin;
	for (const action of ['invite', 'revoke', 'setRole', 'remove']) {
		const res = await request.post(`/teams/no-such-team/members?/${action}`, {
			headers: {
				origin,
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			data: 'email=a%40example.test&role=viewer'
		});
		// A SvelteKit action failure is a 200 envelope with the status inside; check both shapes.
		const body = await res.text();
		expect(
			res.status() === 401 || body.includes('"status":401'),
			`${action}: ${res.status()} ${body}`
		).toBe(true);
	}
});
