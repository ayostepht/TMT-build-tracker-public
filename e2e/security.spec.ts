import { expect, test } from './fixtures';
import { signUp, uniqueEmail } from './helpers';
import { withE2eDb } from './db';

test.describe('origin handling over plain http', () => {
	test('a cross-site form post is rejected', async ({ request }) => {
		const res = await request.post('/onboarding?/create', {
			headers: {
				origin: 'http://evil.example',
				'content-type': 'application/x-www-form-urlencoded'
			},
			data: 'name=x'
		});
		expect(res.status()).toBe(403);
	});

	test('a cross-site auth request with a session is rejected, and a foreign callback too', async ({
		page
	}) => {
		await signUp(page, 'Cross Site', uniqueEmail('cross'));
		const res = await page.request.post('/api/auth/organization/create', {
			headers: { origin: 'http://evil.example' },
			data: { name: 'Evil', slug: 'evil-team' }
		});
		expect(res.status()).toBe(403);
		const social = await page.request.post('/api/auth/sign-in/social', {
			data: { provider: 'google', callbackURL: 'https://evil.example/steal' }
		});
		expect(social.status()).toBe(403);
	});

	test('forwarded https from a proxy is honoured', async ({ request, baseURL }) => {
		const host = new URL(baseURL as string).host;
		const res = await request.post('/onboarding?/create', {
			headers: {
				origin: `https://${host}`,
				'x-forwarded-proto': 'https',
				'content-type': 'application/x-www-form-urlencoded'
			},
			data: 'name=x',
			maxRedirects: 0
		});
		// Past the CSRF check: not signed in, so the app redirects to login instead of 403.
		expect(res.status()).not.toBe(403);
	});
});

test.describe('sessions and rate limits', () => {
	test('a session row stores the user agent but no IP address', async ({ request, baseURL }) => {
		test.skip(!!process.env.E2E_BASE_URL, 'reads the local e2e database file');
		const email = uniqueEmail('noip');
		const headers = { 'user-agent': 'e2e-session-check/1.0', origin: new URL(baseURL!).origin };
		const inn = await request.post('/api/auth/test/sign-in', {
			headers,
			data: { name: 'No Ip', email }
		});
		expect(inn.ok(), `sign-in ${inn.status()} ${await inn.text()}`).toBe(true);

		const rows = await withE2eDb(
			(sql) => sql<{ ip: string | null; ua: string | null }[]>`
				select s.ip_address as ip, s.user_agent as ua
				from "session" s join "user" u on u.id = s.user_id where u.email = ${email}`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(r.ip ?? '').toBe('');
			expect(r.ua ?? '').not.toBe('');
		}
	});

	test('a burst of sign-in starts from one client is rate limited (429)', async ({ request }) => {
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			const res = await request.post('/api/auth/sign-in/social', {
				data: { provider: 'google', callbackURL: '/' }
			});
			statuses.push(res.status());
		}
		expect(statuses, `statuses: ${statuses.join(',')}`).toContain(429);
		expect(statuses[0]).not.toBe(429);
	});
});

test.describe('SSO only', () => {
	test('there is no email/password sign-in, sign-up or reset over HTTP', async ({ request }) => {
		for (const path of [
			'/api/auth/sign-in/email',
			'/api/auth/sign-up/email',
			'/api/auth/request-password-reset',
			'/api/auth/reset-password'
		]) {
			const res = await request.post(path, {
				data: { email: uniqueEmail('nopw'), password: 'correct-horse-battery', name: 'X' }
			});
			expect(res.status(), path).toBeGreaterThanOrEqual(400);
			expect(res.status(), path).toBeLessThan(500);
		}
	});

	test('starting a demo is not an HTTP auth endpoint', async ({ request }) => {
		for (const path of [
			'/api/auth/demo/start',
			'/api/auth/start-demo',
			'/api/auth/sign-in/anonymous'
		]) {
			const res = await request.post(path, { data: {} });
			expect(res.status(), path).toBe(404);
		}
	});

	test('signup redirects to login and keeps only a same-origin redirect', async ({ page }) => {
		await page.goto('/signup?redirect=%2Finvite%2Fabc');
		await expect(page).toHaveURL(/\/login\?redirect=%2Finvite%2Fabc$/);
		for (const bad of [
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			'/\t/evil.example'
		]) {
			await page.goto(`/signup?redirect=${encodeURIComponent(bad)}`);
			await expect(page, bad).toHaveURL(/\/login$/);
		}
	});
});
