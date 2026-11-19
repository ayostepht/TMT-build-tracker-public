import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { adapters } from './adapters';
import { normalizeOctoprint } from './adapters/octoprint';
import { MiniWsServer, sendJson, sendText } from './mini-ws';
import { MAX_FILE_NAME, setResolver } from './outbound';
import { resetFakeSocket, useLoopbackSocket } from './ws-test';
import type { AdapterHandle, PrinterConfig } from './types';

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

describe('a hostile WebSocket peer cannot crash or poison the Moonraker adapter', () => {
	it('survives deep nesting and __proto__ keys, then keeps working', async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (e: unknown) => uncaught.push(e);
		process.on('uncaughtException', onUncaught);
		cleanup.push(() => process.off('uncaughtException', onUncaught));

		const ws = new MiniWsServer();
		await ws.start();
		cleanup.push(() => ws.stop());
		const seen = collect(adapters.moonraker(cfg('moonraker', ws.port)));
		await until(() => ws.sockets.size > 0);
		const sock = [...ws.sockets][0];

		const depth = 100_000; // deeper than the JS stack allows for a recursive merge
		sendText(
			sock,
			'{"id":1,"result":{"status":' + '{"a":'.repeat(depth) + '1' + '}'.repeat(depth) + '}}'
		);
		// (An oversized frame now drops the connection; see adapters.oversize.test.ts.)
		sendText(
			sock,
			'{"jsonrpc":"2.0","method":"notify_status_update","params":[{"__proto__":{"polluted":"yes"}}]}'
		);
		sendJson(sock, {
			jsonrpc: '2.0',
			method: 'notify_status_update',
			params: [
				{ print_stats: { state: 'printing', filename: 'f'.repeat(5000) + '\u0007.gcode' } },
				1
			]
		});
		const p = await until(() => seen.find((s) => s.state === 'printing'));
		expect(p.fileName!.length).toBeLessThanOrEqual(MAX_FILE_NAME);
		expect(p.fileName).not.toContain('\u0007');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(uncaught).toEqual([]);
	}, 20000);
});

describe('printer-reported file names are bounded at the adapter edge', () => {
	const long = 'x'.repeat(900) + '\n.gcode';
	it('octoprint', () => {
		const o = normalizeOctoprint(
			{ state: 'Printing', job: { file: { name: long } }, progress: { completion: 5 } },
			null
		);
		expect(o.fileName!.length).toBeLessThanOrEqual(MAX_FILE_NAME);
		expect(o.fileName).not.toContain('\n');
	});
	it('a normal slicer name passes through unchanged', () => {
		const name = 'TMT_4691_PETG_plate_3_of_7_0.2mm_14h40m.gcode.3mf';
		const o = normalizeOctoprint(
			{ state: 'Printing', job: { file: { name } }, progress: {} },
			null
		);
		expect(o.fileName).toBe(name);
	});
});
