import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrinterConfig } from './types';
import { adapters } from './adapters';
import { openUpstream, CameraError } from './camera';
import { resolveCameraSource } from './camera-source';
import {
	assertOutboundAllowed,
	fetchPinned,
	guardedFetch,
	LINK_ONLY_MESSAGE,
	OutboundError,
	readJsonCapped,
	resolveAllowed,
	safeText,
	setResolver,
	type ResolvedTarget
} from './outbound';
import { createTestDb, dropTestDb } from '../db/testing';
import { organization, user } from '../db/schema';
import { createPrinter, toPublic, updatePrinter } from './store';
import { testConnection } from './supervisor';

afterEach(async () => setResolver(null));

const HOST = 'shared-testtoken12345678.octoeverywhere.com';
const fake = (map: Record<string, string[]>) => async (h: string) => {
	if (!map[h]) throw new Error('ENOTFOUND');
	return map[h];
};

/** A resolver that fails the test when it is asked anything: refusals happen before any DNS. */
const noDns = () => {
	const asked: string[] = [];
	setResolver(async (h) => {
		asked.push(h);
		return ['93.184.216.34'];
	});
	return asked;
};

describe('only an OctoEverywhere link host is ever a destination', () => {
	it('refuses every call that does not allow a share link, before any lookup', async () => {
		const asked = noDns();
		expect(() => assertOutboundAllowed()).toThrow(OutboundError);
		expect(() => assertOutboundAllowed()).toThrow(LINK_ONLY_MESSAGE);
		await expect(resolveAllowed(HOST)).rejects.toThrow(LINK_ONLY_MESSAGE);
		await expect(guardedFetch(`https://${HOST}/api/job`)).rejects.toThrow(LINK_ONLY_MESSAGE);
		expect(asked).toEqual([]);
	});

	it.each([
		['192.168.1.20'],
		['10.0.0.5'],
		['127.0.0.1'],
		['169.254.169.254'],
		['[::1]'],
		['printer.lan'],
		['printer.example.com'],
		['shared-x.octoeverywhere.com.evil.test'],
		['octoeverywhere.com']
	])('refuses %s even when a link is allowed, with no DNS lookup', async (host) => {
		const asked = noDns();
		await expect(resolveAllowed(host, undefined, { allowShareLink: true })).rejects.toThrow(
			LINK_ONLY_MESSAGE
		);
		await expect(
			guardedFetch(`https://${host}/x`, { allowShareLink: true } as RequestInit)
		).rejects.toBeInstanceOf(OutboundError);
		expect(asked).toEqual([]);
	});

	it('a link is reached over https on the default port only', async () => {
		noDns();
		for (const u of [`http://${HOST}/x`, `https://${HOST}:8443/x`])
			await expect(guardedFetch(u, { allowShareLink: true } as RequestInit)).rejects.toThrow(
				/default port/
			);
	});

	it('every adapter reports an error and opens nothing for a printer that has no link', async () => {
		noDns();
		for (const kind of ['elegoo-sdcp', 'moonraker', 'octoprint'] as const) {
			const cfg: PrinterConfig = { id: 'p', kind, host: '192.168.0.9', secrets: { apiKey: 'K' } };
			const seen: { state: string; message?: string }[] = [];
			const h = adapters[kind](cfg);
			h.status$((s) => seen.push(s));
			h.close();
			expect(seen[0], kind).toMatchObject({ state: 'error', message: LINK_ONLY_MESSAGE });
		}
		const manual = adapters.manual({ id: 'p', kind: 'manual', host: 'manual', secrets: {} });
		manual.close();
	});

	it('connection test and camera lookup refuse a printer with no link', async () => {
		const asked = noDns();
		const r = await testConnection({
			id: 'p',
			kind: 'moonraker',
			host: '192.168.0.9',
			secrets: {}
		});
		expect(r).toMatchObject({ ok: false, message: LINK_ONLY_MESSAGE });
		expect(
			await resolveCameraSource({ kind: 'moonraker', cameraEnabled: true, secrets: {} })
		).toBeNull();
		expect(asked).toEqual([]);
	});

	it('a saved row with no link shows why it is never connected', async () => {
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		await db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() });
		const row = await createPrinter(db, 'o', 'u1', {
			name: 'Shop',
			kind: 'moonraker',
			secrets: { shareLink: `https://${HOST}` }
		});
		expect(toPublic(row).blocked).toBeNull();
		expect(toPublic(row).connection).toBe('link');
		// an old row from before links were required: shown as blocked instead of crashing
		const legacy = { ...row, host: '192.168.0.9', secretEnc: null };
		expect(toPublic(legacy).blocked).toBe(LINK_ONLY_MESSAGE);
		// pausing and renaming it still work; anything else needs a link
		expect((await updatePrinter(db, row.id, 'o', { name: 'Renamed' })).name).toBe('Renamed');
	});
});

/** The connection half, against a loopback server (`fetchPinned` validates nothing by design). */
describe('fetchPinned', () => {
	let srv: Server;
	let port = 0;
	let hits: { host?: string; key?: string; url?: string }[] = [];
	const target: ResolvedTarget = {
		host: 'printer.lan',
		ip: '127.0.0.1',
		family: 4,
		literal: false
	};
	const go = (path: string, init: Parameters<typeof fetchPinned>[2] = {}) =>
		fetchPinned(new URL(`http://printer.lan:${port}${path}`), target, init);
	beforeEach(async () => {
		hits = [];
		srv = createServer((req: IncomingMessage, res) => {
			hits.push({
				host: req.headers.host,
				key: String(req.headers['x-api-key'] ?? ''),
				url: req.url
			});
			if (req.url?.startsWith('/redirect')) {
				res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
			} else if (req.url?.startsWith('/big')) {
				res.writeHead(200).end('x'.repeat(2000));
			} else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		port = (srv.address() as AddressInfo).port;
	});
	afterEach(async () => new Promise<void>((r) => srv.close(() => r())));

	it('connects to the validated address and keeps the name in the Host header', async () => {
		const res = await go('/api/job', { headers: { 'x-api-key': 'KEY' } });
		expect(res.status).toBe(200);
		expect(await readJsonCapped(res)).toEqual({ ok: true });
		expect(hits[0].host).toBe(`printer.lan:${port}`);
		expect(hits[0].key).toBe('KEY');
	});
	it('never follows a redirect: the 3xx comes back, the target is never contacted', async () => {
		const res = await go('/redirect', { headers: { 'x-api-key': 'KEY' } });
		expect(res.status).toBe(302);
		expect(hits).toHaveLength(1); // only the original request
	});
	it('refuses non-text request bodies and caps JSON bodies', async () => {
		await expect(
			go('/', { method: 'POST', body: new Uint8Array(2) as never })
		).rejects.toBeInstanceOf(OutboundError);
		const res = await go('/big');
		await expect(readJsonCapped(res, 100)).rejects.toThrow();
	});

	describe('redirects are failures on every path', () => {
		it('camera', async () => {
			const sig = new AbortController().signal;
			const err = await openUpstream(`http://printer.lan:${port}/redirect`, 'printer.lan', sig, {
				connectTimeoutMs: 2000,
				fetchFn: ((u: string | URL) => fetchPinned(new URL(String(u)), target)) as typeof fetch
			}).catch((e) => e);
			expect(err).toBeInstanceOf(CameraError);
			expect(String(err.message)).toMatch(/redirected/);
			expect(hits).toHaveLength(1);
		});
	});
});

/** The resolver half: a link name must resolve to public addresses only. */
describe('resolveAllowed for a link host', () => {
	it('every answer must be public; one inward answer refuses the host', async () => {
		for (const bad of ['10.0.0.1', '169.254.169.254', '127.0.0.1', 'fd00::5'])
			await expect(
				resolveAllowed(HOST, fake({ [HOST]: ['93.184.216.34', bad] }), { allowShareLink: true })
			).rejects.toThrow(/public address/);
	});
	it('an unknown link name fails without echoing the link', async () => {
		const err = await resolveAllowed(HOST, fake({}), { allowShareLink: true }).catch((e) => e);
		expect(err).toBeInstanceOf(OutboundError);
		expect(String(err.message)).not.toContain('testtoken');
	});
});

describe('safeText', () => {
	it('strips control characters, collapses space and caps length', async () => {
		expect(safeText('a\u0000b\r\nc\u0007d')).toBe('a b c d');
		expect(safeText('x'.repeat(500), 50)).toHaveLength(50);
		expect(safeText(42)).toBe('');
	});
});
