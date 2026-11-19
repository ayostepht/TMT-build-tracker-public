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
	await expect(page.getByRole('link', { name: 'Create a team' })).toHaveCount(0);

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
	await post('printer-edit', '/api/printers/x', { name: 'p' }, 'patch');
	await post('printer-delete', '/api/printers/x', {}, 'delete');
	await post('printer-settings', '/api/printers/settings', { organizationId: 'x' }, 'put');
	await post('printer-expect', '/api/printers/x/expect', {});
	await post('printer-job', '/api/printers/jobs/x', { action: 'dismiss' });
	await post('share', '/api/designs/x/share');
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
		'printer-edit',
		'printer-delete',
		'printer-settings',
		'printer-expect',
		'printer-job',
		'share',
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

test('a demo may browse the gallery and copy a design, but never share one', async ({ page }) => {
	const buildId = await startDemo(page);
	const origin = new URL(page.url()).origin;
	// the demo's own sample design (seeded with the build)
	const [own] = await withE2eDb(
		(sql) => sql<{ id: string; slug: string; author: string }[]>`
			select d.id, d.slug, d.author_user_id as author from color_designs d
			join member m on m.user_id = d.author_user_id
			join builds b on b.organization_id = m.organization_id
			where b.id = ${buildId} and d.name = 'Sample colors'`
	);
	expect(own).toBeTruthy();

	const share = await page.request.post(`/api/designs/${own.id}/share`, { headers: { origin } });
	expect(share.status()).toBe(403);
	expect((await share.json()).error).toContain('not available in the demo');
	await withE2eDb(async (sql) => {
		const [r] = await sql<{ shared: boolean }[]>`
			select shared_at is not null as shared from color_designs where id = ${own.id}`;
		expect(r.shared).toBe(false);
	});

	// A design someone else shared (listed here directly): the demo sees it and may copy it.
	const [other] = await withE2eDb(
		(sql) => sql<{ id: string; slug: string }[]>`
			insert into color_designs (id, template_id, slug, name, author_user_id, roles, part_roles,
				shared_at, shared_by)
			select gen_random_uuid()::text, template_id, ${'demo-gallery-' + Date.now().toString(36)}, 'Demo gallery pick',
				null, roles, part_roles, now(), null
			from color_designs where id = ${own.id}
			returning id, slug`
	);
	try {
		await page.goto('/gallery');
		await expect(page.locator(`[data-gallery-design="${other.slug}"]`)).toBeVisible();
		const copy = await page.request.post(`/api/designs/${other.id}/copy`, { headers: { origin } });
		expect(copy.status()).toBe(200);
		const { id } = (await copy.json()) as { id: string };
		await withE2eDb(async (sql) => {
			const [r] = await sql<{ author: string; shared: boolean }[]>`
				select author_user_id as author, shared_at is not null as shared
				from color_designs where id = ${id}`;
			expect(r).toEqual({ author: own.author, shared: false });
		});
	} finally {
		await withE2eDb((sql) => sql`delete from color_designs where id = ${other.id}`);
	}
});
