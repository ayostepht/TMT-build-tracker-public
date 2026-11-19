import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { adapters } from './adapters';
import { MiniWsServer, sendJson, sendText } from './mini-ws';
import { MAX_REMOTE_MESSAGE_BYTES, setResolver } from './outbound';
import { resetFakeSocket, useLoopbackSocket } from './ws-test';
import {
	HOSTILE_BACKOFF_MAX_MS,
	HostileGuard,
	HOSTILE_RESET_MS,
	hostileBackoff,
	OVERSIZED_MESSAGE,
	type AdapterHandle,
	type PrinterConfig
} from './types';

const cleanup: (() => unknown)[] = [];
beforeEach(() => setResolver(async () => ['93.184.216.34']));
afterEach(async () => {
	while (cleanup.length) await cleanup.pop()!();
	resetFakeSocket();
	setResolver(null);
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
const collect = (h: AdapterHandle) => {
	const seen: PrinterStatus[] = [];
	h.status$((s) => seen.push(s));
	cleanup.push(() => h.close());
	return seen;
};
const LINK = 'https://shared-testtoken12345678.octoeverywhere.com';
/** A link printer whose sockets really connect to the loopback mock on `port` (nothing else is dialled). */
const cfg = (kind: PrinterConfig['kind'], port: number, secrets = {}): PrinterConfig => {
	useLoopbackSocket(port);
	return { id: 'p', kind, host: 'octoeverywhere', secrets: { shareLink: LINK, ...secrets } };
};

describe('long backoff after an oversized message', () => {
	it('hostileBackoff starts at 60 s, doubles, caps at 15 min', () => {
		expect(hostileBackoff(1)).toBe(60_000);
		expect(hostileBackoff(2)).toBe(120_000);
		expect(hostileBackoff(3)).toBe(240_000);
		expect(hostileBackoff(5)).toBe(HOSTILE_BACKOFF_MAX_MS);
		expect(hostileBackoff(50)).toBe(HOSTILE_BACKOFF_MAX_MS);
	});
	it('strikes reset only after a period of normal messages', () => {
		let now = 1000;
		const g = new HostileGuard(() => now);
		expect(g.trip()).toBe(60_000);
		g.good();
		now += HOSTILE_RESET_MS - 1;
		g.good(); // not long enough
		expect(g.trip()).toBe(120_000);
		g.good();
		now += HOSTILE_RESET_MS + 1;
		g.good();
		expect(g.trip()).toBe(60_000);
	});
});

describe.each([
	['elegoo-sdcp', (m: MiniWsServer) => cfg('elegoo-sdcp', m.port, { mainboardId: 'MB1' })],
	['moonraker', (m: MiniWsServer) => cfg('moonraker', m.port)]
] as const)('%s: oversized or non-text frame', (kind, mk) => {
	const normal = (sock: Parameters<typeof sendJson>[0]) =>
		kind === 'moonraker'
			? sendJson(sock, {
					jsonrpc: '2.0',
					method: 'notify_status_update',
					params: [{ print_stats: { state: 'printing', filename: 'a.gcode' } }, 1]
				})
			: sendJson(sock, { Topic: 'sdcp/status/MB1', Status: { PrintInfo: { Status: 13 } } });

	it('closes the socket, reports a fixed error and does not reconnect quickly', async () => {
		const ws = new MiniWsServer();
		let connects = 0;
		ws.onConnect = () => connects++;
		await ws.start();
		cleanup.push(() => ws.stop());
		const seen = collect(adapters[kind](mk(ws)));
		await until(() => connects === 1);
		const sock = [...ws.sockets][0];
		const closed = new Promise<void>((r) => sock.on('close', () => r()));
		sendText(sock, '{"x":"' + 'A'.repeat(MAX_REMOTE_MESSAGE_BYTES + 10) + '"}');
		await closed;
		const err = await until(() => seen.find((s) => s.state === 'error'));
		expect(err.message).toBe(OVERSIZED_MESSAGE);
		// A normal reconnect would be back within ~2.5 s.
		await new Promise((r) => setTimeout(r, 3200));
		expect(connects).toBe(1);
		expect(seen.at(-1)?.state).toBe('error'); // not overwritten by "Disconnected"
	}, 15000);

	it('normal traffic is unaffected', async () => {
		const ws = new MiniWsServer();
		await ws.start();
		cleanup.push(() => ws.stop());
		const seen = collect(adapters[kind](mk(ws)));
		await until(() => ws.sockets.size > 0);
		normal([...ws.sockets][0]);
		await until(() => seen.find((s) => s.state === 'printing'));
		expect(seen.some((s) => s.message === OVERSIZED_MESSAGE)).toBe(false);
	});
});

describe('elegoo-sdcp: remote MainboardID is bounded', () => {
	it('a huge or control-laden id is never learned, so never echoed back', async () => {
		const ws = new MiniWsServer();
		const requests: string[] = [];
		ws.onMessage = (_s, t) => requests.push(t);
		await ws.start();
		cleanup.push(() => ws.stop());
		collect(adapters['elegoo-sdcp'](cfg('elegoo-sdcp', ws.port)));
		await until(() => ws.sockets.size > 0);
		sendJson([...ws.sockets][0], { MainboardID: 'AB\u0007' + 'Z'.repeat(5000), Status: {} });
		await new Promise((r) => setTimeout(r, 500));
		// Nothing is sent without a valid id (the id is echoed in every request).
		expect(requests).toEqual([]);
		sendJson([...ws.sockets][0], { MainboardID: 'GOOD-id_1', Status: {} });
		await until(() => requests.length > 0);
		for (const r of requests) {
			const j = JSON.parse(r);
			expect(j.Data.MainboardID).toBe('GOOD-id_1');
			expect(j.Data.Cmd).toBe(1); // read-only
		}
	}, 20000);
});
