import { describe, expect, it, vi } from 'vitest';
import { turnstileConfig, turnstileHostnames, turnstileProblems } from './config.ts';
import {
	TURNSTILE_DEMO_ACTION,
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
		expect(
			turnstileProblems({
				TURNSTILE_SITE_KEY: 'a',
				TURNSTILE_SECRET_KEY: 'b',
				TURNSTILE_HOSTNAMES: 'example.com'
			})
		).toEqual([]);
		const p = turnstileProblems({ TURNSTILE_SECRET_KEY: 'topsecret' });
		expect(p).toHaveLength(1);
		expect(p[0]).not.toContain('topsecret');
	});
});

describe('verifyTurnstile', () => {
	it('accepts a token Cloudflare approves, sending secret, response and address', async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			json({ success: true, action: 'demo-start', hostname: 'tmt.example.com' })
		);
		const r = await verifyTurnstile('tok', '203.0.113.9', {
			secretKey: 's3cret',
			expectedHosts: ['tmt.example.com'],
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
					expectedHosts: ['tmt.example.com'],
					fetch: fetchMock as unknown as typeof fetch
				})
			).toBe('missing');
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('refuses a rejected token', async () => {
		const f = (() =>
			json({ success: false, 'error-codes': ['invalid-input-response'] })) as typeof fetch;
		expect(
			await verifyTurnstile('tok', null, { secretKey: 's', expectedHosts: ['h.example'], fetch: f })
		).toBe('failed');
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
			expect(
				await verifyTurnstile('tok', null, {
					secretKey: 's',
					expectedHosts: ['h.example'],
					fetch: f,
					timeoutMs: 20
				})
			).toBe('error');
	});
});

describe('verifyTurnstile action and hostname', () => {
	const answer = (body: Record<string, unknown>) => (() => json(body)) as typeof fetch;
	const good = { success: true, action: 'demo-start', hostname: 'tmt.example.com' };
	const o = { secretKey: 's', expectedHosts: ['tmt.example.com'] };

	it('accepts the right action and hostname (hostname case-insensitive)', async () => {
		expect(await verifyTurnstile('t', null, { ...o, fetch: answer(good) })).toBe('ok');
		expect(
			await verifyTurnstile('t', null, {
				...o,
				fetch: answer({ ...good, hostname: 'TMT.Example.com' })
			})
		).toBe('ok');
	});
	it('exports the demo action constant', () => {
		expect(TURNSTILE_DEMO_ACTION).toBe('demo-start');
	});
	it('refuses a mismatched or missing action', async () => {
		for (const action of ['login', '', 5, null, undefined]) {
			expect(await verifyTurnstile('t', null, { ...o, fetch: answer({ ...good, action }) })).toBe(
				'failed'
			);
		}
		const noAction = { success: true, hostname: 'tmt.example.com' };
		expect(await verifyTurnstile('t', null, { ...o, fetch: answer(noAction) })).toBe('failed');
	});
	it('refuses a mismatched or missing hostname', async () => {
		expect(
			await verifyTurnstile('t', null, {
				...o,
				fetch: answer({ ...good, hostname: 'evil.example.org' })
			})
		).toBe('failed');
		const noHost = { success: true, action: 'demo-start' };
		expect(await verifyTurnstile('t', null, { ...o, fetch: answer(noHost) })).toBe('failed');
		expect(
			await verifyTurnstile('t', null, { ...o, fetch: answer({ ...good, hostname: 7 }) })
		).toBe('failed');
	});
	it('accepts any host in the expected set', async () => {
		const opts = { secretKey: 's', expectedHosts: ['tmt.example.com', 'www.example.com'] };
		expect(
			await verifyTurnstile('t', null, {
				...opts,
				fetch: answer({ ...good, hostname: 'www.example.com' })
			})
		).toBe('ok');
	});
	it('a replayed or duplicate token is refused', async () => {
		const f = answer({ success: false, 'error-codes': ['timeout-or-duplicate'] });
		expect(await verifyTurnstile('t', null, { ...o, fetch: f })).toBe('failed');
	});
	it('an empty expected set fails closed without calling Cloudflare', async () => {
		const fetchMock = vi.fn<typeof fetch>(() => json(good));
		expect(
			await verifyTurnstile('t', null, {
				secretKey: 's',
				expectedHosts: [],
				fetch: fetchMock as unknown as typeof fetch
			})
		).toBe('error');
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('defaults to the host of PUBLIC_URL and never to localhost', async () => {
		vi.stubEnv('TURNSTILE_HOSTNAMES', '');
		vi.stubEnv('PUBLIC_URL', 'https://tmt.example.com');
		try {
			expect(await verifyTurnstile('t', null, { secretKey: 's', fetch: answer(good) })).toBe('ok');
			expect(
				await verifyTurnstile('t', null, {
					secretKey: 's',
					fetch: answer({ ...good, hostname: 'localhost' })
				})
			).toBe('failed');
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('turnstileHostnames', () => {
	it('is empty by default, with no localhost', () => {
		expect(turnstileHostnames({})).toEqual([]);
	});
	it('takes the PUBLIC_URL host plus a trimmed, lower-cased, comma-separated list', () => {
		expect(
			turnstileHostnames({
				PUBLIC_URL: 'https://Tmt.Example.com',
				TURNSTILE_HOSTNAMES: ' WWW.example.com , ,example.com,tmt.example.com'
			})
		).toEqual(['tmt.example.com', 'www.example.com', 'example.com']);
		expect(turnstileHostnames({ TURNSTILE_HOSTNAMES: 'example.com' })).toEqual(['example.com']);
	});
	it('drops entries that are not bare hostnames and warns naming each one', () => {
		const bad = ['https://x.com', 'x.com:443', 'x.com/path', '*.x.com', 'x.com.', 'a b.com'];
		const env = {
			TURNSTILE_SITE_KEY: 'a',
			TURNSTILE_SECRET_KEY: 'b',
			PUBLIC_URL: 'https://tmt.example.com',
			TURNSTILE_HOSTNAMES: [...bad, 'www.example.com'].join(',')
		};
		expect(turnstileHostnames(env)).toEqual(['tmt.example.com', 'www.example.com']);
		const p = turnstileProblems(env);
		expect(p).toHaveLength(bad.length);
		for (const b of bad) expect(p.some((m) => m.includes(`"${b}"`))).toBe(true);
	});
	it('warns about a bad entry and an empty set together', () => {
		const p = turnstileProblems({
			TURNSTILE_SITE_KEY: 'a',
			TURNSTILE_SECRET_KEY: 'b',
			TURNSTILE_HOSTNAMES: 'https://x.com'
		});
		expect(p).toHaveLength(2);
	});
	it('warns at boot when keys are set but no hostname is expected', () => {
		const keys = { TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' };
		expect(turnstileProblems(keys)).toHaveLength(1);
		expect(turnstileProblems({ ...keys, PUBLIC_URL: 'https://tmt.example.com' })).toEqual([]);
		expect(turnstileProblems({ ...keys, TURNSTILE_HOSTNAMES: 'example.com' })).toEqual([]);
		expect(turnstileProblems({})).toEqual([]);
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
