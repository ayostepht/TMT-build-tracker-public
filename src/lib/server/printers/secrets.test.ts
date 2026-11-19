import { describe, expect, it } from 'vitest';
import { decryptSecrets, encryptSecrets } from './secrets';
import { createTestDb, dropTestDb } from '../db/testing';
import { organization, printers, user } from '../db/schema';
import { createPrinter, toPublic } from './store';

describe('printer secrets', () => {
	it('round-trips and uses a fresh IV each time', async () => {
		const a = encryptSecrets({ apiKey: '12345678', mainboardId: 'S1' }, 'k1');
		const b = encryptSecrets({ apiKey: '12345678', mainboardId: 'S1' }, 'k1');
		expect(a).not.toBe(b);
		expect(a).not.toContain('12345678');
		expect(decryptSecrets(a, 'k1')).toEqual({ apiKey: '12345678', mainboardId: 'S1' });
	});
	it('fails closed with the wrong key or a tampered blob', async () => {
		const a = encryptSecrets({ apiKey: 'abc' }, 'k1');
		expect(decryptSecrets(a, 'k2')).toEqual({});
		const parts = a.split('.');
		parts[3] = Buffer.from('tampered').toString('base64url');
		expect(decryptSecrets(parts.join('.'), 'k1')).toEqual({});
		expect(decryptSecrets(null)).toEqual({});
		expect(decryptSecrets('garbage')).toEqual({});
	});

	it('never appears in the public view or its JSON', async () => {
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		await db.insert(organization).values({ id: 'o', name: 'O', slug: 'o', createdAt: new Date() });
		const row = await createPrinter(db, 'o', 'u1', {
			name: 'Klipper',
			kind: 'moonraker',
			secrets: {
				apiKey: 'SUPERSECRET1',
				shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com'
			}
		});
		expect(row.secretEnc).toBeTruthy();
		expect(row.secretEnc).not.toContain('SUPERSECRET1');
		const pub = toPublic(row);
		const json = JSON.stringify(pub);
		expect(json).not.toContain('SUPERSECRET1');
		expect(json).not.toContain('secretEnc');
		expect(json).not.toContain('shared-aaaaaaaa1111');
		expect(pub.secretsSet.sort()).toEqual(['apiKey', 'shareLink']);
		expect(pub.identifiers).toEqual({});
		expect(await db.select().from(printers)).toHaveLength(1);
	});
});
