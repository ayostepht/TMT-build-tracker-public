import { describe, expect, it } from 'vitest';
import { mergeStatus } from './adapters/moonraker';
import {
	extractFilaments,
	normalizeSdcpStatus,
	SDCP_ALLOWED_COMMANDS,
	sdcpEnvelope
} from './adapters/sdcp';

// How the adapters are driven (through an OctoEverywhere link, read-only) is covered in
// `share-link.test.ts`, `connections.test.ts` and `connections.limits.test.ts`; these are the
// pure mappings.

describe('elegoo-sdcp', () => {
	it('builds read-only requests only: there is no write command', () => {
		expect([...SDCP_ALLOWED_COMMANDS]).toEqual([]);
		for (const cmd of [0, 1]) {
			const msg = JSON.parse(sdcpEnvelope(cmd, {}, 'MB1'));
			expect(msg.Data.Cmd).toBe(cmd);
			expect(msg.Data.Data).toEqual({});
			expect(msg.Topic).toBe('sdcp/request/MB1');
		}
		for (const cmd of [386, 129, 130, 131, 2, 128])
			expect(() => sdcpEnvelope(cmd, {}, 'MB1'), String(cmd)).toThrow(/not allowed/);
		expect(() => sdcpEnvelope(386, { Enable: 1 }, 'MB1')).toThrow(/not allowed/);
		expect(() => sdcpEnvelope(0, { a: 1 }, 'MB1')).toThrow(/takes no data/);
	});

	it('maps status codes', () => {
		const n = (status: number, cur = [1]) =>
			normalizeSdcpStatus({
				CurrentStatus: cur,
				PrintInfo: { Status: status, Filename: 'a.gcode', Progress: 5 }
			});
		expect(n(13).state).toBe('printing');
		expect(n(16).state).toBe('printing'); // preheating while a job runs
		expect(n(16, [0]).state).toBe('idle');
		expect(n(1, [9]).state).toBe('idle'); // manual homing
		expect(n(6).state).toBe('paused');
		expect(n(9).state).toBe('done');
		expect(n(14).state).toBe('error');
		expect(normalizeSdcpStatus({ TempOfNozzle: [200, 199.5], PrintInfo: {} }).nozzleC).toBe(199.5);
	});
	it('reads canvas-like tray lists when present and ignores them otherwise', () => {
		expect(extractFilaments({ Foo: 1 })).toEqual([]);
		const f = extractFilaments({
			CanvasInfo: {
				trays: [{ filament_color: '0xFF0000', filament_type: 'PLA' }, { color: '#00ff00' }]
			}
		});
		expect(f).toEqual([
			{ slot: 'A1', color: '#FF0000', type: 'PLA' },
			{ slot: 'A2', color: '#00ff00', type: undefined }
		]);
	});
});

describe('moonraker', () => {
	it('merges partial updates deeply', () => {
		expect(mergeStatus({ a: { b: 1, c: 2 } }, { a: { c: 3 }, d: 4 })).toEqual({
			a: { b: 1, c: 3 },
			d: 4
		});
	});
});
