import { describe, expect, it } from 'vitest';
import { createTestDb, dropTestDb } from '../db/testing';
import { organization, user } from '../db/schema';
import { ApiError } from '../access';
import { configFromInput, createPrinter, updatePrinter } from './store';
import { decryptSecrets } from './secrets';

const L1 = 'https://shared-testtoken12345678.octoeverywhere.com';
const L2 = 'https://shared-othertoken87654321.octoeverywhere.com';

async function setup() {
	const db = await createTestDb();
	await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
	await db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() });
	const elegoo = await createPrinter(db, 'o', 'u1', {
		name: 'Linked',
		kind: 'elegoo-sdcp',
		secrets: { shareLink: L1, mainboardId: 'MB1' }
	});
	const octo = await createPrinter(db, 'o', 'u1', {
		name: 'Octo',
		kind: 'octoprint',
		secrets: { shareLink: L1, apiKey: 'KEY' }
	});
	const manual = await createPrinter(db, 'o', 'u1', { name: 'Bench', kind: 'manual' });
	return { db, elegoo, octo, manual };
}

describe('stored secrets belong to the link they were saved for', () => {
	it('keeping the same link keeps everything stored with it; a typed address is ignored', async () => {
		const { db, octo } = setup();
		const r = await updatePrinter(db, octo.id, 'o', { host: '10.0.0.9', name: 'Renamed' });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L1, apiKey: 'KEY' });
		expect(r.host).toBe('octoeverywhere'); // an address cannot hide next to a link
		const t = await configFromInput(db, 'o', { id: octo.id, host: '10.0.0.9' });
		expect(t.host).toBe('octoeverywhere');
		expect(t.secrets).toEqual({ shareLink: L1, apiKey: 'KEY' });
	});

	it('typing the same link again does not drop the stored key', async () => {
		const { db, octo } = setup();
		const r = await updatePrinter(db, octo.id, 'o', { secrets: { shareLink: `${L1}/` } });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L1, apiKey: 'KEY' });
	});

	it('changing the link replaces it and carries nothing else over (no key rides to another relay)', async () => {
		const { db, octo, elegoo } = setup();
		const r = await updatePrinter(db, octo.id, 'o', { secrets: { shareLink: L2 } });
		expect(decryptSecrets(r.secretEnc)).toEqual({ shareLink: L2 });
		const e = await updatePrinter(db, elegoo.id, 'o', { secrets: { shareLink: L2 } });
		expect(decryptSecrets(e.secretEnc)).toEqual({ shareLink: L2 });
		// a connection test behaves the same: the typed link gets only what was typed
		const t = await configFromInput(db, 'o', { id: octo.id, secrets: { shareLink: L2 } });
		expect(t.secrets).toEqual({ shareLink: L2 });
		const typed = await configFromInput(db, 'o', {
			id: octo.id,
			secrets: { shareLink: L2, apiKey: 'NEW' }
		});
		expect(typed.secrets).toEqual({ shareLink: L2, apiKey: 'NEW' });
	});

	it('a link cannot be removed: a connected printer always has one', async () => {
		const { db, octo } = setup();
		expect(() => await updatePrinter(db, octo.id, 'o', { secrets: { shareLink: '' } })).toThrow(
			ApiError
		);
		expect(
			() => await configFromInput(db, 'o', { id: octo.id, secrets: { shareLink: '' } })
		).toThrow(/shared link/i);
		// pausing and renaming stay possible
		expect((await updatePrinter(db, octo.id, 'o', { enabled: false })).enabled).toBe(false);
	});

	it('a manual printer holds no secrets and no address, and cannot become a link printer without a link', async () => {
		const { db, manual } = setup();
		expect(manual).toMatchObject({ host: 'manual', secretEnc: null, port: null, cameraUrl: null });
		const m = await updatePrinter(db, manual.id, 'o', { secrets: { shareLink: L1 } });
		expect(m.secretEnc).toBeNull(); // still manual: no secrets kept
		expect(() => await updatePrinter(db, manual.id, 'o', { kind: 'octoprint' })).toThrow(
			/shared link/i
		);
		const ok = await updatePrinter(db, manual.id, 'o', {
			kind: 'octoprint',
			secrets: { shareLink: L2 }
		});
		expect(ok.host).toBe('octoeverywhere');
		expect(decryptSecrets(ok.secretEnc)).toEqual({ shareLink: L2 });
	});

	it('a printer type that cannot use a link is refused', async () => {
		const { db } = setup();
		expect(
			() =>
				await createPrinter(db, 'o', 'u1', {
					name: 'x',
					kind: 'manual',
					secrets: { shareLink: L1 }
				})
		).not.toThrow();
		expect(
			() =>
				await createPrinter(db, 'o', 'u1', {
					name: 'x',
					kind: 'bambu-lan',
					secrets: { shareLink: L1 }
				})
		).toThrow(/Unknown printer type/);
	});
});
