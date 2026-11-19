/**
 * r49 security fixes: socket flood budget, handshake timeout, silent-socket close, instance-wide
 * and manual printer caps, the test-route rate limit and uniform hosted failures, and the camera
 * URL cap. Nothing here opens a real socket: the socket seam (`setSocketFactory`) gets an in-memory fake
 * BEFORE any adapter is created, DNS is a stub, and HTTP goes through an injected fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { first } from '#lib/server/db/index.ts';
import { createTestDb } from '../db/testing';
import { organization, printers, user } from '../db/schema';
import { adapters } from './adapters';
import { resolveCameraSource, MAX_CAMERA_URLS, type CameraTarget } from './camera-source';
import { resolveAllowed, setResolver } from './outbound';
import { createPrinter, updatePrinter } from './store';
import { HOSTED_LINK_FAILURE, limitTests, TEST_RATE, uniformHostedFailure } from './test-limit';
import {
	FLOODED_MESSAGE,
	MessageBudget,
	OVERSIZED_MESSAGE,
	SOCKET_MAX_MESSAGES_PER_SEC,
	type PrinterConfig
} from './types';
import { resetWriteRate } from '../write-rate';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { resetFakeSocket, useFakeSocket } from './ws-test';

const HOST = 'shared-testtoken12345678.octoeverywhere.com';
const LINK = `https://${HOST}`;

/** In-memory stand-in for the `ws` socket (injected through the socket seam): never touches the network. */
class FakeWs {
	static all: FakeWs[] = [];
	readyState = 0;
	closed = false;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onclose: ((e: { code?: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((e: { data: unknown; bytes?: number }) => void) | null = null;
	constructor(public url: string) {
		FakeWs.all.push(this);
	}
	send(d: string) {
		this.sent.push(d);
	}
	close() {
		this.closed = true;
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	deliver(data: unknown) {
		// Like the real client: the size is the byte length on the wire.
		this.onmessage?.({
			data,
			bytes: typeof data === 'string' ? Buffer.byteLength(data) : undefined
		});
	}
}

const cfg = (kind: PrinterConfig['kind'], secrets: Record<string, string> = { shareLink: LINK }) =>
	({ id: 'p', kind, host: 'octoeverywhere', port: null, secrets }) as PrinterConfig;
const flush = () => vi.advanceTimersByTimeAsync(0);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
	FakeWs.all = [];
	vi.useFakeTimers();
	useFakeSocket(FakeWs);
	setResolver(async () => ['93.184.216.34']);
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	resetFakeSocket();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	setResolver(null);
	resetWriteRate();
});

function watch(h: ReturnType<(typeof adapters)['moonraker']>) {
	const seen: PrinterStatus[] = [];
	h.status$((s) => seen.push(s));
	return seen;
}

describe('MessageBudget', () => {
	it('allows the budget per one-second window, then refuses, then resets', async () => {
		let now = 1000;
		const b = new MessageBudget(() => now, 3, 100);
		expect([b.take(10), b.take(10), b.take(10), b.take(10)]).toEqual([true, true, true, false]);
		now += 1000;
		expect(b.take(60)).toBe(true);
		expect(b.take(60)).toBe(false); // bytes over 100 in the window
	});
});

describe('link sockets are pinned to the validated address', () => {
	it.each(['moonraker', 'elegoo-sdcp'] as const)(
		'%s: the dial gets the resolved public address and the link host as server name',
		async (kind) => {
			const pins: Parameters<typeof useFakeSocket>[1] = [];
			useFakeSocket(FakeWs, pins);
			const h = adapters[kind](cfg(kind));
			watch(h);
			await flush();
			expect(pins).toEqual([{ ip: '93.184.216.34', family: 4, servername: HOST }]);
			h.close();
		}
	);
	it('a printer with no link opens no socket at all', async () => {
		useFakeSocket(FakeWs);
		setResolver(async () => ['192.168.1.20']);
		const h = adapters.moonraker({
			id: 'p',
			kind: 'moonraker',
			host: 'printer.local',
			secrets: {}
		});
		watch(h);
		await flush();
		expect(FakeWs.all).toHaveLength(0);
		h.close();
	});
});

describe('flooding peers (Klipper and Elegoo sockets)', () => {
	it('Klipper over a link: a message flood closes the socket and waits well over linkBackoff', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		const msg = JSON.stringify({ jsonrpc: '2.0', method: 'notify_proc_stat_update', params: [] });
		for (let i = 0; i < SOCKET_MAX_MESSAGES_PER_SEC; i++) ws.deliver(msg);
		expect(ws.closed).toBe(false); // exactly the budget is fine
		ws.deliver(msg);
		expect(ws.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ state: 'error', message: FLOODED_MESSAGE });
		await tick(59_000);
		expect(FakeWs.all).toHaveLength(1); // hostile penalty: 60 s at least
		await tick(2000);
		expect(FakeWs.all).toHaveLength(2);
		h.close();
	});

	it('a big message burst trips the bytes budget; an over-cap message is never parsed', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		const parse = vi.spyOn(JSON, 'parse');
		const huge = 'x'.repeat(1024 * 1024 + 1);
		ws.deliver(huge);
		expect(ws.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ state: 'error', message: OVERSIZED_MESSAGE });
		expect(parse.mock.calls.some((c) => c[0] === huge)).toBe(false);
		await tick(62_000);
		const ws2 = FakeWs.all[1];
		ws2.open();
		const chunk = JSON.stringify({ a: 'y'.repeat(900 * 1024) });
		ws2.deliver(chunk);
		ws2.deliver(chunk);
		expect(ws2.closed).toBe(false);
		ws2.deliver(chunk); // 2.7 MB in one second
		expect(ws2.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ message: FLOODED_MESSAGE });
		h.close();
	});

	it('the budget counts bytes, not characters', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		// 400k two-byte characters = 800 KB per message (under the 1 MiB cap, 400k "characters").
		const chunk = JSON.stringify({ a: '\u00e9'.repeat(400_000) });
		ws.deliver(chunk);
		ws.deliver(chunk);
		expect(ws.closed).toBe(false); // 1.6 MB
		ws.deliver(chunk); // 2.4 MB > 2 MiB, though only 1.2M characters
		expect(ws.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ message: FLOODED_MESSAGE });
		h.close();
	});

	it('a close with code 1009 (the socket refused a frame over the cap) is the oversize state with a long backoff', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		ws.onclose?.({ code: 1009 });
		expect(seen.at(-1)).toMatchObject({ state: 'error', message: OVERSIZED_MESSAGE });
		await tick(59_000);
		expect(FakeWs.all).toHaveLength(1);
		await tick(2000);
		expect(FakeWs.all).toHaveLength(2);
		h.close();
	});

	it('Elegoo over a link: the same budget applies', async () => {
		const h = adapters['elegoo-sdcp'](cfg('elegoo-sdcp'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		expect(ws.url).toBe(`wss://${HOST}/websocket`);
		ws.open();
		const msg = JSON.stringify({ Topic: 'sdcp/status/X', Status: {} });
		for (let i = 0; i <= SOCKET_MAX_MESSAGES_PER_SEC; i++) ws.deliver(msg);
		expect(ws.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ message: FLOODED_MESSAGE });
		h.close();
	});
});

describe('handshake timeout and silent sockets', () => {
	it('Klipper over a link: a handshake that never completes is abandoned after 10 s and retried slowly', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		await tick(9_000);
		expect(ws.closed).toBe(false);
		await tick(1_500);
		expect(ws.closed).toBe(true);
		expect(seen.at(-1)).toMatchObject({ state: 'offline', message: /Timed out connecting/ });
		await tick(8_000); // linkBackoff(0) is at least 10 s after the abandon
		expect(FakeWs.all).toHaveLength(1);
		await tick(3_000);
		expect(FakeWs.all).toHaveLength(2);
		h.close();
	});

	it('Elegoo over a link: the same handshake timeout', async () => {
		const h = adapters['elegoo-sdcp'](cfg('elegoo-sdcp'));
		await flush();
		expect(FakeWs.all).toHaveLength(1); // the stub was used: nothing real was dialled
		await tick(10_500);
		expect(FakeWs.all[0].closed).toBe(true);
		h.close();
	});

	it('Klipper over a link: silence reports offline at 45 s but the socket is closed only at 120 s', async () => {
		const h = adapters.moonraker(cfg('moonraker'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		await tick(46_000);
		expect(ws.closed).toBe(false);
		expect(seen.at(-1)).toMatchObject({ state: 'offline', message: 'No data from the printer' });
		await tick(70_000); // 116 s
		expect(ws.closed).toBe(false);
		await tick(5_000); // 121 s
		expect(ws.closed).toBe(true);
		await tick(9_000);
		expect(FakeWs.all).toHaveLength(1); // linkBackoff: not at once
		await tick(3_000);
		expect(FakeWs.all).toHaveLength(2);
		h.close();
	});

	it('Elegoo over a link: offline at 20 s, closed only at 120 s; data in between keeps it open', async () => {
		const h = adapters['elegoo-sdcp'](cfg('elegoo-sdcp'));
		const seen = watch(h);
		await flush();
		const ws = FakeWs.all[0];
		ws.open();
		await tick(21_000);
		expect(ws.closed).toBe(false);
		expect(seen.at(-1)).toMatchObject({ state: 'offline', message: 'No data from the printer' });
		ws.deliver(JSON.stringify({ Topic: 'sdcp/status/X', Status: {} })); // data re-arms it
		await tick(100_000);
		expect(ws.closed).toBe(false);
		await tick(25_000);
		expect(ws.closed).toBe(true);
		h.close();
	});
});

describe('caps (public quota defaults)', () => {
	const setup = async () => {
		vi.stubEnv('TMT_MODE', 'public');
		vi.stubEnv('BETTER_AUTH_SECRET', 'unit-test-secret-not-for-production-0123456789abcdef');
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		for (const id of ['o1', 'o2', 'o3'])
			await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
		return db;
	};
	const link = (n: number) => ({
		name: `p${n}`,
		kind: 'octoprint',
		secrets: { shareLink: `https://shared-token${n}abcdefgh.octoeverywhere.com` }
	});

	it('an instance-wide cap on link printers (default 200), with a clear 409', async () => {
		const db = await setup();
		vi.stubEnv('QUOTA_LINK_PRINTERS_TOTAL', '3');
		vi.stubEnv('QUOTA_LINK_PRINTERS_PER_WORKSPACE', 'off');
		await createPrinter(db, 'o1', 'u1', link(1));
		await createPrinter(db, 'o2', 'u1', link(2));
		await createPrinter(db, 'o3', 'u1', link(3));
		let err: unknown;
		try {
			await createPrinter(db, 'o1', 'u1', link(4));
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({
			status: 409,
			code: 'quota',
			message: expect.stringMatching(/This server has reached its limit of printers connected/)
		});
		expect(await db.select().from(printers)).toHaveLength(3);
		// moving an existing link printer to another link is not a new one
		const firstPrinter = (await first(
			db.select().from(printers).where(eq(printers.organizationId, 'o1'))
		))!;
		await expect(
			updatePrinter(db, firstPrinter.id, 'o1', {
				secrets: { shareLink: 'https://shared-tokenzzabcdefgh.octoeverywhere.com' }
			})
		).resolves.not.toThrow();
		// `off` removes it; self-hosted has none by default
		vi.stubEnv('QUOTA_LINK_PRINTERS_TOTAL', 'off');
		await expect(createPrinter(db, 'o1', 'u1', link(5))).resolves.not.toThrow();
	});

	it('concurrent adds cannot pass the per-workspace cap together', async () => {
		const db = await setup();
		const results = await Promise.allSettled(
			[1, 2, 3, 4, 5, 6].map((n) => createPrinter(db, 'o1', 'u1', link(n)))
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
		expect(await db.select().from(printers)).toHaveLength(3);
	});

	it('the instance-wide default is 200 in public mode', async () => {
		const db = await setup();
		vi.stubEnv('QUOTA_LINK_PRINTERS_PER_WORKSPACE', 'off');
		const rows = Array.from({ length: 200 }, (_, i) => ({
			organizationId: 'o1',
			name: `x${i}`,
			kind: 'octoprint',
			host: 'octoeverywhere'
		}));
		for (const r of rows) await db.insert(printers).values(r);
		await expect(createPrinter(db, 'o2', 'u1', link(1))).rejects.toThrow(
			/limit of printers connected/
		);
	});

	it('manual printers: 10 per workspace by default, configurable, in any mode', async () => {
		const db = await setup();
		for (let i = 0; i < 10; i++)
			await createPrinter(db, 'o1', 'u1', { name: `m${i}`, kind: 'manual' });
		let err: unknown;
		try {
			await createPrinter(db, 'o1', 'u1', { name: 'm10', kind: 'manual' });
		} catch (e) {
			err = e;
		}
		expect(err).toMatchObject({
			status: 409,
			code: 'quota',
			message: expect.stringMatching(/already has 10 printers that are not connected/)
		});
		await createPrinter(db, 'o2', 'u1', { name: 'other workspace', kind: 'manual' });
		// turning a link printer into a manual one counts too
		const l = await createPrinter(db, 'o3', 'u1', link(1));
		vi.stubEnv('QUOTA_MANUAL_PRINTERS_PER_WORKSPACE', '0');
		await expect(updatePrinter(db, l.id, 'o3', { kind: 'manual' })).rejects.toThrow(
			/Ask the admin/
		);
		vi.stubEnv('QUOTA_MANUAL_PRINTERS_PER_WORKSPACE', 'off');
		expect((await updatePrinter(db, l.id, 'o3', { kind: 'manual' })).kind).toBe('manual');
		vi.unstubAllEnvs();
		// the caps do not depend on TMT_MODE: the same default applies without it
		const sh = await createTestDb();
		await sh.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		await sh.insert(organization).values({ id: 'o1', name: 'o', slug: 'o', createdAt: new Date() });
		for (let i = 0; i < 10; i++)
			await createPrinter(sh, 'o1', 'u1', { name: `m${i}`, kind: 'manual' });
		await expect(createPrinter(sh, 'o1', 'u1', { name: 'm10', kind: 'manual' })).rejects.toThrow(
			/not connected/
		);
	});
});

describe('test routes: rate limit and uniform hosted failures', () => {
	it('10 a minute with a burst of 5 per user, separately per user', async () => {
		const now = 1_000_000;
		for (let i = 0; i < TEST_RATE.burst; i++) limitTests('u1', now);
		expect(() => limitTests('u1', now)).toThrow(ApiError);
		try {
			limitTests('u1', now);
		} catch (e) {
			expect(e).toMatchObject({ status: 429, message: expect.stringMatching(/Too many tests/) });
		}
		expect(() => limitTests('u2', now)).not.toThrow();
		expect(() => limitTests('u1', now + 7_000)).not.toThrow(); // refills 1 per 6 s
	});

	it('"link not found", "points inward" and "refused" are the same sentence', async () => {
		const fail = async (answers: () => Promise<string[]>) => {
			setResolver(answers);
			try {
				await uniformHostedFailure(() => resolveAllowed(HOST, undefined, { allowShareLink: true }));
			} catch (e) {
				return (e as Error).message;
			}
			return 'no error';
		};
		const msgs = await Promise.all([
			fail(async () => {
				throw new Error('ENOTFOUND');
			}),
			fail(async () => []),
			fail(async () => ['10.0.0.5'])
		]);
		expect(new Set(msgs)).toEqual(new Set([HOSTED_LINK_FAILURE]));
		// an address (not a link host) gives the same sentence too
		await expect(
			uniformHostedFailure(() => resolveAllowed('192.168.0.5', undefined, { allowShareLink: true }))
		).rejects.toThrow(HOSTED_LINK_FAILURE);
	});
});

describe('camera URLs from a remote printer', () => {
	const t = (): CameraTarget => ({
		kind: 'moonraker',
		cameraEnabled: true,
		secrets: { shareLink: LINK }
	});
	const answer = (webcams: unknown[]) =>
		(async () => new Response(JSON.stringify({ result: { webcams } }))) as unknown as typeof fetch;

	it('looks at no more than 4 webcam entries', async () => {
		const bad = { stream_url: 'http://192.168.0.9/s', snapshot_url: 'http://192.168.0.9/p' };
		const cams = [bad, bad, bad, bad, { stream_url: '/webcam/?action=stream' }];
		expect(await resolveCameraSource(t(), { fetchFn: answer(cams) })).toBeNull();
		const ok = await resolveCameraSource(t(), {
			fetchFn: answer([bad, bad, bad, { stream_url: '/webcam/?action=stream' }])
		});
		expect(ok?.urls).toEqual([`${LINK}/webcam/?action=stream`]);
		expect(MAX_CAMERA_URLS).toBe(4);
	});

	it('drops a URL longer than 500 characters', async () => {
		const long = `/webcam/${'a'.repeat(600)}`;
		expect(await resolveCameraSource(t(), { fetchFn: answer([{ stream_url: long }]) })).toBeNull();
	});
});
