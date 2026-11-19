import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../access';
import type { Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { member, organization, user } from '../db/schema';
import {
	DuplicateFilamentError,
	createCustomFilament,
	deleteCustomFilament,
	listCustomFilaments,
	updateCustomFilament
} from './custom';

let db: Db;
const body = (o: Record<string, unknown> = {}) => ({
	brand: 'TestBrand',
	material: 'PETG HF',
	colorName: 'Team Red',
	hex: '#D31F26',
	...o
});
const status = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiError) return e.status;
		throw e;
	}
	return 0;
};

beforeEach(async () => {
	db = await createTestDb();
	for (const id of ['org1', 'org2'])
		await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
	for (const [u, org, role] of [
		['owner', 'org1', 'owner'],
		['editor', 'org1', 'editor'],
		['viewer', 'org1', 'viewer'],
		['outsider', 'org2', 'owner']
	]) {
		await db
			.insert(user)
			.values({ id: u, name: u, email: `${u}@example.test`, createdAt: new Date() });
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: org, userId: u, role, createdAt: new Date() });
	}
});

afterEach(() => dropTestDb(db));

describe('custom filaments', () => {
	it('editors create, members list, normalized', async () => {
		const f = await createCustomFilament(
			db,
			'org1',
			'editor',
			body({ finish: 'Silk', notes: ' hi ' })
		);
		expect(f).toMatchObject({ brand: 'TestBrand', hex: '#d31f26', finish: 'silk', notes: 'hi' });
		expect((await listCustomFilaments(db, 'org1', 'viewer')).map((x) => x.id)).toEqual([f.id]);
	});

	it('permissions: viewer 403, outsider 404', async () => {
		expect(await status(() => createCustomFilament(db, 'org1', 'viewer', body()))).toBe(403);
		expect(await status(() => createCustomFilament(db, 'org1', 'outsider', body()))).toBe(404);
		expect(await status(() => listCustomFilaments(db, 'org1', 'outsider'))).toBe(404);
		const f = await createCustomFilament(db, 'org1', 'owner', body());
		expect(await status(() => updateCustomFilament(db, f.id, 'viewer', body()))).toBe(403);
		expect(await status(() => updateCustomFilament(db, f.id, 'outsider', body()))).toBe(404);
		expect(await status(() => deleteCustomFilament(db, f.id, 'viewer'))).toBe(403);
		expect(await status(() => deleteCustomFilament(db, f.id, 'outsider'))).toBe(404);
		expect(await status(() => deleteCustomFilament(db, 'nope', 'owner'))).toBe(404);
	});

	it('scopes filaments to the workspace', async () => {
		await createCustomFilament(db, 'org1', 'owner', body());
		await createCustomFilament(db, 'org2', 'outsider', body({ brand: 'Other' }));
		expect((await listCustomFilaments(db, 'org2', 'outsider')).map((x) => x.brand)).toEqual([
			'Other'
		]);
	});

	it('duplicate brand+type+name is 409 with the existing id', async () => {
		const f = await createCustomFilament(db, 'org1', 'owner', body());
		try {
			await createCustomFilament(
				db,
				'org1',
				'editor',
				body({ brand: ' testbrand', colorName: 'team  red' })
			);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(DuplicateFilamentError);
			expect((e as DuplicateFilamentError).status).toBe(409);
			expect((e as DuplicateFilamentError).existingId).toBe(f.id);
		}
		// Same color in another workspace is fine; a different type is fine.
		await createCustomFilament(db, 'org2', 'outsider', body());
		await createCustomFilament(db, 'org1', 'owner', body({ material: 'PETG' }));
		// Renaming onto another filament's identity conflicts; keeping your own does not.
		const g = await createCustomFilament(db, 'org1', 'owner', body({ colorName: 'Blue' }));
		await expect(updateCustomFilament(db, g.id, 'owner', body())).rejects.toThrow(
			DuplicateFilamentError
		);
		expect(
			(await updateCustomFilament(db, g.id, 'owner', body({ colorName: 'Blue', hex: '#0000ff' })))
				.hex
		).toBe('#0000ff');
	});

	it('update and delete', async () => {
		const f = await createCustomFilament(db, 'org1', 'owner', body());
		const u = await updateCustomFilament(
			db,
			f.id,
			'editor',
			body({ colorName: 'Fire Red', url: 'https://example.com/p' })
		);
		expect(u).toMatchObject({ colorName: 'Fire Red', url: 'https://example.com/p' });
		expect(u.updatedAt).not.toBeNull();
		await deleteCustomFilament(db, f.id, 'editor');
		expect(await listCustomFilaments(db, 'org1', 'owner')).toEqual([]);
	});

	it.each([
		['bad hex', { hex: 'red' }],
		['short hex', { hex: '#fff' }],
		['no brand', { brand: ' ' }],
		['no material', { material: '' }],
		['no color name', { colorName: undefined }],
		['long brand', { brand: 'x'.repeat(61) }],
		['long notes', { notes: 'x'.repeat(501) }],
		['bad finish', { finish: 'rainbow' }],
		['bad link', { url: 'javascript:alert(1)' }],
		['non-text brand', { brand: 5 }]
	])('rejects %s with 400', async (_n, o) => {
		expect(await status(() => createCustomFilament(db, 'org1', 'owner', body(o)))).toBe(400);
	});

	it('rejects a non-object body', async () => {
		expect(await status(() => createCustomFilament(db, 'org1', 'owner', null))).toBe(400);
	});
});
