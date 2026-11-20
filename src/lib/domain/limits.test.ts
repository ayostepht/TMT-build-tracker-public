import { describe, expect, it } from 'vitest';
import * as shared from './limits';
import * as server from '../server/builds/limits';

describe('text limits', () => {
	it('the server module re-exports the shared numbers', () => {
		for (const [k, v] of Object.entries(server)) {
			expect(v, k).toBe((shared as Record<string, number>)[k]);
		}
		expect(server.BUILD_NAME_MAX).toBe(200);
		expect(server.HANDOFF_NOTES_MAX).toBe(4000);
	});
	it('every cap is a positive integer', () => {
		for (const [k, v] of Object.entries(shared)) {
			expect(Number.isInteger(v) && v > 0, k).toBe(true);
		}
	});
});
