import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { adapters } from './adapters';
import { safeError } from './types';
import { testConnection } from './supervisor';
import { normalizeSdcpStatus, SDCP_ALLOWED_COMMANDS, sdcpEnvelope } from './adapters/sdcp';
import { backoff, linkBackoff, OVERSIZED_MESSAGE } from './types';
import { setResolver } from './outbound';
import { resolveCameraSource, type CameraTarget } from './camera-source';
import { MockSdcp } from './mock-sdcp';
import { decryptSecrets } from './secrets';
import { createTestDb, dropTestDb } from '../db/testing';
import { organization, printers, user } from '../db/schema';
import { configFromInput, createPrinter, toConfig, toPublic, updatePrinter } from './store';
import type { PrinterConfig } from './types';
import { checkCameraUrl } from '#lib/printers/camera-url.ts';
import { resetFakeSocket, useFakeSocket } from './ws-test';

// A made-up token: never a real link.
const HOST = 'shared-testtoken12345678.octoeverywhere.com';
const LINK = `https://${HOST}`;

const cleanup: (() => unknown)[] = [];
// The link name resolves to a public address (never a real lookup); the guard validates it.
beforeEach(async () => setResolver(async () => ['93.184.216.34']));
afterEach(async () => {
	setResolver(null);
	vi.unstubAllGlobals();
	resetFakeSocket();
	while (cleanup.length) await cleanup.pop()!();
});
async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error('timeout');
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Stand-in for the global WebSocket: records the URL asked for and talks to the local mock. */
function stubSocket(mockPort: number) {
	const urls: string[] = [];
	const Real = WebSocket;
	class Redirect extends Real {
		constructor(url: string | URL) {
			urls.push(String(url));
			super(`ws://127.0.0.1:${mockPort}/websocket`);
		}
	}
	useFakeSocket(Redirect);
	return urls;
}

const linkCfg = (secrets: Record<string, string> = { shareLink: LINK }): PrinterConfig => ({
	id: 'p',
	kind: 'elegoo-sdcp',
	host: 'octoeverywhere',
	secrets
});

describe('elegoo-sdcp through an OctoEverywhere link', () => {
	it('connects to wss://<link>/websocket, learns the id from the push, sends only Cmd 1', async () => {
		const mock = new MockSdcp();
		mock.pushOnConnect = true;
		await mock.start();
		cleanup.push(() => mock.stop());
		const urls = stubSocket(mock.port);
		const h = adapters['elegoo-sdcp'](linkCfg());
		cleanup.push(() => h.close());
		const seen: PrinterStatus[] = [];
		h.status$((s) => seen.push(s));

		await until(() => seen.find((s) => s.state === 'idle'));
		mock.printing('Plate 1.gcode', 40);
		await until(() => seen.find((s) => s.state === 'printing' && s.progress === 40));
		await until(() => mock.received.some((r) => r.cmd === 1));
		await new Promise((r) => setTimeout(r, 4600)); // longer than the direct 4 s poll

		expect(urls).toEqual([`wss://${HOST}/websocket`]);
		// Cmd 1 once (attributes); no Cmd 0 polling, no write command at all.
		expect(mock.received.map((r) => r.cmd)).toEqual([1]);
		expect(mock.cameraEnables).toBe(0);
	}, 15000);

	it('has no write command: nothing but reads is ever sent', async () => {
		expect([...SDCP_ALLOWED_COMMANDS]).toEqual([]);
		expect(() => sdcpEnvelope(386, { Enable: 1 }, 'MB1')).toThrow(/not allowed/);
		expect(() => sdcpEnvelope(0, { x: 1 }, 'MB1')).toThrow(/takes no data/);
		const mock = new MockSdcp();
		await mock.start();
		cleanup.push(() => mock.stop());
		const urls = stubSocket(mock.port);
		const h = adapters['elegoo-sdcp'](linkCfg());
		cleanup.push(() => h.close());
		await new Promise((r) => setTimeout(r, 200));
		expect(urls.filter((u) => u.startsWith('wss://')).length).toBe(1); // only the status socket
		expect(mock.cameraEnables).toBe(0);
		expect(mock.received.every((r) => r.cmd !== 386)).toBe(true);
	});

	it('a link that is not the pinned shape is never dialled, and no address is used', async () => {
		const urls: string[] = [];
		useFakeSocket(
			class {
				constructor(u: string) {
					urls.push(u);
				}
				close() {}
			}
		);
		const seen: PrinterStatus[] = [];
		const h = adapters['elegoo-sdcp']({
			...linkCfg({ shareLink: 'https://evil.example', mainboardId: 'X' }),
			host: '10.1.2.3'
		});
		h.status$((s) => seen.push(s));
		await new Promise((r) => setTimeout(r, 50));
		h.close();
		expect(urls).toEqual([]);
		expect(seen[0]?.state).toBe('error');
	});
});

describe('camera through an OctoEverywhere link', () => {
	const t = (o: Partial<CameraTarget>): CameraTarget => ({
		kind: 'elegoo-sdcp',
		cameraEnabled: true,
		secrets: { shareLink: LINK },
		...o
	});
	it('uses the link /video, pinned to the link host', async () => {
		const s = await resolveCameraSource(t({}));
		expect(s).toEqual({ urls: [`${LINK}/video`], origin: 'default', host: HOST, shareLink: true });
	});
	it('never opens the guard to another host', async () => {
		// no usable link: nothing is dialled
		expect(
			await resolveCameraSource(t({ secrets: { shareLink: 'https://evil.example' } }))
		).toBeNull();
		expect(await resolveCameraSource(t({ secrets: {} }))).toBeNull();
		expect(await resolveCameraSource(t({ cameraEnabled: false }))).toBeNull();
	});
});

describe('shared link storage', () => {
	const setup = async () => {
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		await db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() });
		return db;
	};
	const body = (extra: Record<string, unknown> = {}) => ({
		name: 'Shop CC',
		kind: 'elegoo-sdcp',
		secrets: { shareLink: `${LINK}/` },
		...extra
	});

	it('stores the link encrypted, needs no address, and never returns it', async () => {
		const db = setup();
		const row = await createPrinter(db, 'o', 'u1', body());
		expect(row.host).toBe('octoeverywhere');
		expect(row.secretEnc).not.toContain(HOST);
		expect(decryptSecrets(row.secretEnc)).toEqual({ shareLink: LINK });
		for (const editor of [true, false]) {
			void editor;
			const pub = toPublic(row);
			expect(JSON.stringify(pub)).not.toContain('octoeverywhere.com');
			expect(JSON.stringify(pub)).not.toContain('shared-');
			expect(pub.secretsSet).toEqual(['shareLink']);
			expect(pub.identifiers).toEqual({});
		}
		expect(toConfig(row).secrets.shareLink).toBe(LINK);
		expect(await db.select().from(printers)).toHaveLength(1);
	});

	it('rejects a bad link without echoing it, and a missing link', async () => {
		const db = setup();
		let msg = '';
		try {
			await createPrinter(
				db,
				'o',
				'u1',
				body({ secrets: { shareLink: 'https://evil.example/x' } })
			);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toBeTruthy();
		expect(msg).not.toContain('evil.example');
		// a connected printer needs a link: an address alone is no longer a way to add one
		expect(
			() =>
				await createPrinter(db, 'o', 'u1', { name: 'x', kind: 'elegoo-sdcp', host: '192.168.0.5' })
		).toThrow(/shared link/i);
		// Bambu LAN is gone: it is not a printer type any more
		expect(() => await createPrinter(db, 'o', 'u1', body({ kind: 'bambu-lan' }))).toThrow(
			/Unknown printer type/
		);
		expect(await db.select().from(printers)).toHaveLength(0);
	});

	it('keeps the link on edit, ignores a typed address or camera address, and refuses to clear it', async () => {
		const db = setup();
		const row = await createPrinter(
			db,
			'o',
			'u1',
			body({ cameraUrl: 'http://10.0.0.5:3031/video', host: '10.0.0.5', port: 3030 })
		);
		expect(row.cameraUrl).toBeNull();
		expect(row.host).toBe('octoeverywhere');
		expect(row.port).toBeNull();
		const a = await updatePrinter(db, row.id, 'o', {
			name: 'Renamed',
			cameraUrl: 'http://10.0.0.5/x',
			host: '10.0.0.5'
		});
		expect(a.cameraUrl).toBeNull();
		expect(a.host).toBe('octoeverywhere');
		expect(decryptSecrets(a.secretEnc)).toEqual({ shareLink: LINK });
		// a link printer cannot go back to an address: clearing the link is refused
		expect(() => await updatePrinter(db, row.id, 'o', { secrets: { shareLink: '' } })).toThrow(
			/shared link/i
		);
		// pausing and renaming stay possible
		expect((await updatePrinter(db, row.id, 'o', { enabled: false })).enabled).toBe(false);
	});

	it('connection tests use the stored link when none is typed', async () => {
		const db = setup();
		const row = await createPrinter(db, 'o', 'u1', body());
		const cfg = await configFromInput(db, 'o', { id: row.id, kind: 'elegoo-sdcp' });
		expect(cfg.secrets.shareLink).toBe(LINK);
		const typed = await configFromInput(db, 'o', {
			kind: 'elegoo-sdcp',
			secrets: { shareLink: LINK }
		});
		expect(typed.host).toBe('octoeverywhere');
		expect(typed.secrets.shareLink).toBe(LINK);
	});
});

describe('credential hygiene (review findings)', () => {
	const setup = async () => {
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		await db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() });
		return db;
	};

	it('M1: an address is never stored: a typed host (a pasted link included) is ignored', async () => {
		const db = setup();
		for (const host of [HOST, LINK, `${LINK}/`, 'foo.octoeverywhere.com', '192.168.0.5']) {
			expect(
				() => await createPrinter(db, 'o', 'u1', { name: 'x', kind: 'elegoo-sdcp', host }),
				host
			).toThrow(/shared link/i);
		}
		expect(await db.select().from(printers)).toHaveLength(0);
		const row = await createPrinter(db, 'o', 'u1', {
			name: 'x',
			kind: 'elegoo-sdcp',
			host: 'printer.local',
			secrets: { shareLink: LINK }
		});
		expect(row.host).toBe('octoeverywhere');
		expect(JSON.stringify(row)).not.toContain('printer.local');
	});

	it('L1: the placeholder host without a usable link is never dialled', async () => {
		const dialled: string[] = [];
		useFakeSocket(
			class {
				constructor(u: string) {
					dialled.push(u);
				}
				close() {}
			}
		);
		for (const kind of ['elegoo-sdcp', 'moonraker', 'octoprint'] as const) {
			const seen: PrinterStatus[] = [];
			const h = adapters[kind]({ id: 'p', kind, host: 'octoeverywhere', secrets: {} });
			h.status$((s) => seen.push(s));
			h.close();
			expect(seen[0]?.state, kind).toBe('offline');
			expect(seen[0]?.message, kind).toMatch(/shared link is missing/i);
		}
		expect(dialled).toEqual([]);
		const r = await testConnection(linkCfg({}), 300);
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/shared link is missing/i);
	});

	it('L2: tests cannot end up dialling the placeholder', async () => {
		const db = setup();
		const row = await createPrinter(db, 'o', 'u1', {
			name: 'Shop CC',
			kind: 'elegoo-sdcp',
			secrets: { shareLink: LINK }
		});
		expect(
			() =>
				await configFromInput(db, 'o', {
					id: row.id,
					kind: 'elegoo-sdcp',
					secrets: { shareLink: '' }
				})
		).toThrow(/shared link/i);
		expect(
			() => await configFromInput(db, 'o', { kind: 'bambu-lan', secrets: { shareLink: LINK } })
		).toThrow(/Unknown printer type/);
		expect(
			(await configFromInput(db, 'o', { id: row.id, kind: 'elegoo-sdcp' })).secrets.shareLink
		).toBe(LINK);
	});

	it('L3: link camera URLs must be https on the default port, on every hop', async () => {
		for (const bad of [
			`http://${HOST}/video`,
			`https://${HOST}:8443/video`,
			`http://${HOST}:80/video`
		])
			expect(checkCameraUrl(bad, HOST).ok, bad).toBe(false);
		expect(checkCameraUrl(`https://${HOST}:443/video`, HOST).ok).toBe(true);
	});

	it('L4: safeError masks share-link hosts', async () => {
		const m = safeError(new Error(`connect failed wss://${HOST}/websocket`));
		expect(m).not.toContain('octoeverywhere.com');
		expect(m).not.toContain('testtoken');
	});
});

/** Hand-driven WebSocket: no network, the test decides when it opens, speaks and closes. */
function fakeSockets() {
	const socks: FakeWs[] = [];
	class FakeWs {
		readyState = 0;
		sent: string[] = [];
		onopen: (() => void) | null = null;
		onmessage: ((ev: { data: unknown }) => void) | null = null;
		onerror: (() => void) | null = null;
		onclose: (() => void) | null = null;
		constructor() {
			socks.push(this);
		}
		send(d: string) {
			this.sent.push(d);
		}
		close() {}
		open() {
			this.readyState = 1;
			this.onopen?.();
		}
		push(data: unknown) {
			this.onmessage?.({ data });
		}
		hangUp() {
			this.readyState = 3;
			this.onclose?.();
		}
	}
	useFakeSocket(FakeWs);
	return socks;
}
const STATUS = JSON.stringify({ Status: { CurrentStatus: [0], PrintInfo: { Status: 0 } } });
describe('sdcp reconnect backoff', () => {
	afterEach(async () => vi.useRealTimers());

	it('link backoff is slower than the plain backoff and capped at 5 minutes', async () => {
		for (let a = 0; a < 10; a++) {
			expect(linkBackoff(a)).toBeGreaterThanOrEqual(10_000);
			expect(linkBackoff(a)).toBeLessThan(300_500);
			expect(linkBackoff(a)).toBeGreaterThan(backoff(a) - 500 - 1);
		}
		expect(linkBackoff(0)).toBeLessThan(10_500);
		expect(linkBackoff(9)).toBeGreaterThanOrEqual(300_000);
		expect(backoff(0)).toBeLessThan(2500); // the plain backoff is unchanged
	});

	it('a relay that accepts and closes at once is not re-dialled at a fixed pace', async () => {
		vi.useFakeTimers();
		const socks = fakeSockets();
		const h = adapters['elegoo-sdcp'](linkCfg());
		cleanup.push(() => h.close());
		await vi.advanceTimersByTimeAsync(0); // the guard resolves the host before dialling
		expect(socks.length).toBe(1);
		socks[0].open();
		socks[0].hangUp(); // attempt 0 -> ~10 s
		await vi.advanceTimersByTimeAsync(9_000);
		expect(socks.length).toBe(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(socks.length).toBe(2);
		socks[1].open(); // onopen alone must not reset the backoff
		socks[1].hangUp(); // attempt 1 -> ~20 s
		await vi.advanceTimersByTimeAsync(15_000);
		expect(socks.length).toBe(2);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(socks.length).toBe(3);
	});

	it('resets after the first valid Status frame', async () => {
		vi.useFakeTimers();
		const socks = fakeSockets();
		const h = adapters['elegoo-sdcp'](linkCfg());
		cleanup.push(() => h.close());
		await vi.advanceTimersByTimeAsync(0);
		socks[0].open();
		socks[0].hangUp();
		await vi.advanceTimersByTimeAsync(11_000);
		socks[1].open();
		socks[1].push(STATUS);
		socks[1].hangUp(); // reset by the frame -> base delay again
		await vi.advanceTimersByTimeAsync(11_000);
		expect(socks.length).toBe(3);
	});
});

describe('sdcp untrusted frames', () => {
	afterEach(async () => vi.useRealTimers());

	it('survives bad JSON; a non-text or oversize frame drops the socket (audit: long backoff)', async () => {
		vi.useFakeTimers();
		const socks = fakeSockets();
		const h = adapters['elegoo-sdcp'](linkCfg({ shareLink: LINK, mainboardId: 'MB1' }));
		cleanup.push(() => h.close());
		const seen: PrinterStatus[] = [];
		h.status$((s) => seen.push(s));
		await vi.advanceTimersByTimeAsync(0);
		socks[0].open();
		socks[0].push('{not json');
		expect(seen.length).toBe(0);
		socks[0].push(STATUS);
		expect(seen.length).toBe(1);
		expect(seen[0].state).toBe('idle');
		socks[0].push('x'.repeat(1024 * 1024 + 1));
		expect(seen.at(-1)?.message).toBe(OVERSIZED_MESSAGE);
		socks[0].push(STATUS); // the dropped socket is no longer listened to
		expect(seen.length).toBe(2);
	});

	it('learns a MainboardID only when it looks like one', async () => {
		return (async () => {
			vi.useFakeTimers();
			const socks = fakeSockets();
			const h = adapters['elegoo-sdcp'](linkCfg());
			cleanup.push(() => h.close());
			await vi.advanceTimersByTimeAsync(0);
			socks[0].open();
			socks[0].push(
				JSON.stringify({ Topic: 'sdcp/status/bad id"}', Status: { PrintInfo: { Status: 0 } } })
			);
			expect(socks[0].sent).toEqual([]); // bad id ignored, nothing sent
			socks[0].push(
				JSON.stringify({
					Topic: 'sdcp/status/GOOD-id_1',
					Status: { PrintInfo: { Status: 0 } }
				})
			);
			expect(socks[0].sent.length).toBe(1);
			expect(JSON.parse(socks[0].sent[0]).Data.MainboardID).toBe('GOOD-id_1');
			expect(JSON.parse(socks[0].sent[0]).Data.Cmd).toBe(1);
		})();
	});

	it('trims a long, control-character file name', async () => {
		const st = normalizeSdcpStatus({
			CurrentStatus: [1],
			PrintInfo: { Status: 13, Filename: `a\u0000b\n${'x'.repeat(500)}` }
		});
		expect(st.fileName).toBeDefined();
		expect(st.fileName!.length).toBeLessThanOrEqual(200);
		// eslint-disable-next-line no-control-regex
		expect(st.fileName).not.toMatch(/[\u0000-\u001f]/);
		// control characters become spaces (shared `safeText`), so the name stays one readable line
		expect(st.fileName!.startsWith('a b xxx')).toBe(true);
	});

	it('caps the filament list and its strings', async () => {
		const trays = Array.from({ length: 40 }, () => ({
			filament_color: `0x${'F'.repeat(100)}`,
			filament_type: 'T'.repeat(100)
		}));
		const st = normalizeSdcpStatus({ PrintInfo: { Status: 0 } }, { CanvasInfo: trays });
		expect(st.filaments?.length).toBe(16);
		expect(st.filaments![0].type!.length).toBeLessThanOrEqual(32);
		expect(st.filaments![0].color!.length).toBeLessThanOrEqual(32);
	});
});
