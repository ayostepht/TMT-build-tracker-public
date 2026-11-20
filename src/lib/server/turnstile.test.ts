import { describe, expect, it, vi } from 'vitest';
import { turnstileConfig, turnstileProblems } from './config.ts';
import {
	TURNSTILE_ORIGIN,
	TURNSTILE_VERIFY_URL,
	verifyTurnstile,
	withTurnstile
} from './turnstile.ts';
import { securityHeaders } from './security-headers.ts';

const json = (body: unknown, status = 200) =>
	Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('turnstileConfig', () => {
	it('is on only with both keys', () => {
		expect(turnstileConfig({})).toBeNull();
		expect(turnstileConfig({ TURNSTILE_SITE_KEY: 'a' })).toBeNull();
		expect(turnstileConfig({ TURNSTILE_SECRET_KEY: 'b' })).toBeNull();
		expect(turnstileConfig({ TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET_KEY: 'b' })).toBeNull();
		expect(turnstileConfig({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' })).toEqual({
			siteKey: 'a',
			secretKey: 'b'
		});
	});
	it('warns about a half-set pair, never about none or both', () => {
		expect(turnstileProblems({})).toEqual([]);
		expect(turnstileProblems({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' })).toEqual([]);
		const p = turnstileProblems({ TURNSTILE_SECRET_KEY: 'topsecret' });
		expect(p).toHaveLength(1);
		expect(p[0]).not.toContain('topsecret');
	});
});

describe('verifyTurnstile', () => {
	it('accepts a token Cloudflare approves, sending secret, response and address', async () => {
		const fetchMock = vi.fn<typeof fetch>(() => json({ success: true }));
		const r = await verifyTurnstile('tok', '203.0.113.9', {
			secretKey: 's3cret',
			fetch: fetchMock as unknown as typeof fetch
		});
		expect(r).toBe('ok');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(TURNSTILE_VERIFY_URL);
		expect(init?.method).toBe('POST');
		const body = init?.body as URLSearchParams;
		expect(body.get('secret')).toBe('s3cret');
		expect(body.get('response')).toBe('tok');
		expect(body.get('remoteip')).toBe('203.0.113.9');
	});
	it('refuses without calling Cloudflare when there is no usable token', async () => {
		const fetchMock = vi.fn();
		for (const t of [undefined, null, '', 5, 'x'.repeat(3000)]) {
			expect(
				await verifyTurnstile(t, '203.0.113.9', {
					secretKey: 's',
					fetch: fetchMock as unknown as typeof fetch
				})
			).toBe('missing');
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('refuses a rejected token', async () => {
		const f = (() =>
			json({ success: false, 'error-codes': ['invalid-input-response'] })) as typeof fetch;
		expect(await verifyTurnstile('tok', null, { secretKey: 's', fetch: f })).toBe('failed');
	});
	it('fails closed on a bad status, unreadable answer, network error and timeout', async () => {
		const cases: (typeof fetch)[] = [
			(() => json({ success: true }, 500)) as typeof fetch,
			(() => Promise.resolve(new Response('<html>', { status: 200 }))) as typeof fetch,
			(() => Promise.reject(new TypeError('network down'))) as typeof fetch,
			((_u: unknown, init?: RequestInit) =>
				new Promise((_res, rej) => {
					init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
				})) as typeof fetch
		];
		for (const f of cases)
			expect(await verifyTurnstile('tok', null, { secretKey: 's', fetch: f, timeoutMs: 20 })).toBe(
				'error'
			);
	});
});

describe('verifyTurnstile hostname', () => {
	const ok = (hostname?: string) => (() => json({ success: true, hostname })) as typeof fetch;
	it('requires the answer hostname to match the expected host when both are known', async () => {
		const o = { secretKey: 's', expectedHost: 'tmt.example.com' };
		expect(await verifyTurnstile('t', null, { ...o, fetch: ok('tmt.example.com') })).toBe('ok');
		expect(await verifyTurnstile('t', null, { ...o, fetch: ok('TMT.example.com') })).toBe('ok');
		expect(await verifyTurnstile('t', null, { ...o, fetch: ok('evil.example.org') })).toBe(
			'failed'
		);
	});
	it('skips the check without an expected host or without a hostname in the answer', async () => {
		expect(
			await verifyTurnstile('t', null, {
				secretKey: 's',
				expectedHost: null,
				fetch: ok('x.example')
			})
		).toBe('ok');
		expect(
			await verifyTurnstile('t', null, {
				secretKey: 's',
				expectedHost: 'tmt.example.com',
				fetch: ok()
			})
		).toBe('ok');
	});
	it('defaults to the host of PUBLIC_URL', async () => {
		vi.stubEnv('PUBLIC_URL', 'https://tmt.example.com');
		try {
			expect(
				await verifyTurnstile('t', null, { secretKey: 's', fetch: ok('evil.example.org') })
			).toBe('failed');
			expect(
				await verifyTurnstile('t', null, { secretKey: 's', fetch: ok('tmt.example.com') })
			).toBe('ok');
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('Turnstile CSP', () => {
	const kitCsp =
		"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'nonce-abc'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'";
	const headers = (extra?: ReturnType<typeof withTurnstile>) =>
		securityHeaders({
			pathname: '/demo',
			https: true,
			contentType: 'text/html',
			hasCsp: true,
			existingCsp: kitCsp,
			extraSources: extra
		})['content-security-policy'];

	it('adds exactly Cloudflare to script, connect and frame sources, replacing frame-src none', () => {
		const csp = headers(withTurnstile({ scriptSrc: [], connectSrc: [] }))!;
		expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' 'nonce-abc' ${TURNSTILE_ORIGIN}`);
		expect(csp).toContain(`connect-src 'self' ${TURNSTILE_ORIGIN}`);
		expect(csp).toContain(`frame-src ${TURNSTILE_ORIGIN}`);
		expect(csp).not.toContain("frame-src 'none'");
		expect(csp).not.toMatch(/unsafe-inline|\*/);
		expect(csp).toContain("frame-ancestors 'none'");
	});
	it('keeps the analytics origins beside it', () => {
		const csp = headers(
			withTurnstile({ scriptSrc: ['https://plausible.io'], connectSrc: ['https://plausible.io'] })
		)!;
		expect(csp).toContain('https://plausible.io');
		expect(csp).toContain(TURNSTILE_ORIGIN);
	});
	it('leaves the policy untouched without extra sources', () => {
		expect(headers(undefined)).toBe(undefined);
	});
});
