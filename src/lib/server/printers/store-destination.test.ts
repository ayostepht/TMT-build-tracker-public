import { describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db';
import { organization, user } from '../db/schema';
import { ApiError } from '../access';
import { configFromInput, createPrinter, updatePrinter } from './store';
import { decryptSecrets } from './secrets';

const L1 = 'https://shared-testtoken12345678.octoeverywhere.com';
const L2 = 'https://shared-othertoken87654321.octoeverywhere.com';

function setup() {
	const db = openDb(':memory:');
	runMigrations(db);
	db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' }).run();
	db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() }).run();
	const elegoo = createPrinter(db, 'o', 'u1', {
		name: 'Linked',
		kind: 'elegoo-sdcp',
		secrets: { shareLink: L1, mainboardId: 'MB1' }
	});
	const octo = createPrinter(db, 'o', 'u1', {
		name: 'Octo',
		kind: 'octoprint',
		secrets: { shareLink: L1, apiKey: 'KEY' }
	});
	const manual = createPrinter(db, 'o', 'u1', { name: 'Bench', kind: 'manual' });
	return { db, elegoo, octo, manual };
}

describe('stored secrets belong to the link they were saved for', () => {
	it('keeping the same link keeps everything stored with it; a typed address is ignored', () => {
		const { db, octo } = setup();
		const r = updatePrinter(db, octo.id, 'o', { host: '10.0.0.9', name: 'Renamed' });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L1, apiKey: 'KEY' });
		expect(r.host).toBe('octoeverywhere'); // an address cannot hide next to a link
		const t = configFromInput(db, 'o', { id: octo.id, host: '10.0.0.9' });
		expect(t.host).toBe('octoeverywhere');
		expect(t.secrets).toEqual({ shareLink: L1, apiKey: 'KEY' });
	});

	it('typing the same link again does not drop the stored key', () => {
		const { db, octo } = setup();
		const r = updatePrinter(db, octo.id, 'o', { secrets: { shareLink: `${L1}/` } });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L1, apiKey: 'KEY' });
	});

	it('changing the link replaces it and carries nothing else over (no key rides to another relay)', () => {
		const { db, octo, elegoo } = setup();
		const r = updatePrinter(db, octo.id, 'o', { secrets: { shareLink: L2 } });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L2 });
		const e = updatePrinter(db, elegoo.id, 'o', { secrets: { shareLink: L2 } });
		expect(decryptSecrets(e.secretEnc)).toEqual({ shareLink: L2 });
		// a connection test behaves the same: the typed link gets only what was typed
		const t = configFromInput(db, 'o', { id: octo.id, secrets: { shareLink: L2 } });
		expect(t.secrets).toEqual({ shareLink: L2 });
		const typed = configFromInput(db, 'o', {
			id: octo.id,
			secrets: { shareLink: L2, apiKey: 'NEW' }
		});
		expect(typed.secrets).toEqual({ shareLink: L2, apiKey: 'NEW' });
	});

	it('a link cannot be removed: a connected printer always has one', () => {
		const { db, octo } = setup();
		expect(() => updatePrinter(db, octo.id, 'o', { secrets: { shareLink: '' } })).toThrow(ApiError);
		expect(() => configFromInput(db, 'o', { id: octo.id, secrets: { shareLink: '' } })).toThrow(
			/shared link/i
		);
		// pausing and renaming stay possible
		expect(updatePrinter(db, octo.id, 'o', { enabled: false }).enabled).toBe(false);
	});

	it('a manual printer holds no secrets and no address, and cannot become a link printer without a link', () => {
		const { db, manual } = setup();
		expect(manual).toMatchObject({ host: 'manual', secretEnc: null, port: null, cameraUrl: null });
		const m = updatePrinter(db, manual.id, 'o', { secrets: { shareLink: L1 } });
		expect(m.secretEnc).toBeNull(); // still manual: no secrets kept
		expect(() => updatePrinter(db, manual.id, 'o', { kind: 'octoprint' })).toThrow(/shared link/i);
		const ok = updatePrinter(db, manual.id, 'o', { kind: 'octoprint', secrets: { shareLink: L2 } });
		expect(ok.host).toBe('octoeverywhere');
		expect(decryptSecrets(ok.secretEnc)).toEqual({ shareLink: L2 });
	});

	it('a printer type that cannot use a link is refused', () => {
		const { db } = setup();
		expect(() =>
			createPrinter(db, 'o', 'u1', { name: 'x', kind: 'manual', secrets: { shareLink: L1 } })
		).not.toThrow();
		expect(() =>
			createPrinter(db, 'o', 'u1', { name: 'x', kind: 'bambu-lan', secrets: { shareLink: L1 } })
		).toThrow(/Unknown printer type/);
	});
});
