import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { activity, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addSpool, MAX_SPOOL_ADDS, removeSpoolAdd, updateFilament } from './actions';
import { createBuild } from './create';
import { updateBuildDesign } from '../designs/mutate';
import { loadBuildView } from './view';
import { filamentStats, stockKg } from '../../domain/accounting';
import { describeActivity } from '../../domain/activity';

let db: Db;
let templateId: string;
const orgId = 'org1';

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const u of ['owner', 'editor', 'viewer']) {
		await db.insert(user).values({ id: u, name: `User ${u}`, email: `${u}@example.test` });
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: orgId, userId: u, role: u, createdAt: new Date() });
	}
});

const mk = async (kind: 'build' | 'draft' = 'build') =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', kind },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const status = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return 0;
};
const acts = async (id: string, kind: string) =>
	(await db.select().from(activity).where(eq(activity.buildId, id))).filter((a) => a.kind === kind);

describe('spool adds', () => {
	it('adds with a date, user and note; stock is start + adds', async () => {
		const id = await mk();
		const f0 = (await view(id)).filaments[0];
		const add = await addSpool(db, id, 'editor', f0.key, { kg: 1.234, note: ' Overture restock ' });
		const f = (await view(id)).filaments[0];
		expect(f.spoolAdds).toHaveLength(1);
		expect(f.spoolAdds![0]).toMatchObject({
			id: add,
			kg: 1.23,
			userId: 'editor',
			userName: 'User editor',
			note: 'Overture restock'
		});
		expect(Date.now() - f.spoolAdds![0].at).toBeLessThan(5000);
		expect(stockKg(f)).toBe(Math.round((f0.spools + 1.23) * 100) / 100);
		const st = filamentStats(await view(id)).find((s) => s.role === f.key)!;
		expect(st.haveGrams).toBeCloseTo((f0.spools + 1.23) * 1000);
		expect(st.startKg).toBe(f0.spools);
		expect(st.addedKg).toBe(1.23);
		const row = (await acts(id, 'filament.stock.add')).at(-1)!;
		expect(row.payload).toMatchObject({
			role: f.key,
			kg: 1.23,
			addId: add,
			note: 'Overture restock'
		});
		const v = await view(id);
		expect(describeActivity(v.activity[0], v)).toMatch(
			/^User editor added 1\.23 kg of .+ \(Overture restock\)$/
		);
	});

	it('removes an add; unknown add 404', async () => {
		const id = await mk();
		const key = (await view(id)).filaments[0].key;
		const add = await addSpool(db, id, 'owner', key, { kg: 1 });
		await removeSpoolAdd(db, id, 'owner', key, add);
		expect((await view(id)).filaments[0].spoolAdds).toEqual([]);
		expect(await acts(id, 'filament.stock.remove')).toHaveLength(1);
		expect(await status(async () => await removeSpoolAdd(db, id, 'owner', key, add))).toBe(404);
		expect(await status(async () => await removeSpoolAdd(db, id, 'owner', key, '__proto__'))).toBe(
			404
		);
	});

	it('limits kg, note length and the number of adds per slot', async () => {
		const id = await mk();
		const key = (await view(id)).filaments[0].key;
		for (const kg of [0, 0.004, -1, 99.5, NaN, '1', null, undefined]) {
			expect(await status(async () => await addSpool(db, id, 'owner', key, { kg }))).toBe(400);
		}
		expect(
			await status(
				async () => await addSpool(db, id, 'owner', key, { kg: 1, note: 'x'.repeat(201) })
			)
		).toBe(400);
		expect(await status(async () => await addSpool(db, id, 'owner', key, { kg: 1, note: 5 }))).toBe(
			400
		);
		expect(await status(async () => await addSpool(db, id, 'owner', key, 'x'))).toBe(400);
		await addSpool(db, id, 'owner', key, { kg: 99, note: 'x'.repeat(200) });
		await addSpool(db, id, 'owner', key, { kg: 0.01 });
		for (let i = 2; i < MAX_SPOOL_ADDS; i++) await addSpool(db, id, 'owner', key, { kg: 1 });
		expect((await view(id)).filaments[0].spoolAdds).toHaveLength(MAX_SPOOL_ADDS);
		expect(await status(async () => await addSpool(db, id, 'owner', key, { kg: 1 }))).toBe(400);
	});

	it('stores a note without control characters', async () => {
		const id = await mk();
		const key = (await view(id)).filaments[0].key;
		await addSpool(db, id, 'owner', key, { kg: 1, note: ' a\nb\r\n\tc\u0000d\u0001e\u202ef ' });
		const note = (await view(id)).filaments[0].spoolAdds![0].note!;
		expect(note).toBe('a b c d e f');
		expect((await acts(id, 'filament.stock.add')).at(-1)!.payload).toMatchObject({ note });
		await addSpool(db, id, 'owner', key, { kg: 1, note: '\n\u0000' });
		expect((await view(id)).filaments[0].spoolAdds![1].note).toBeUndefined();
	});

	it('is for owners and editors; viewers 403, outsiders 404, drafts 400', async () => {
		const id = await mk();
		const key = (await view(id)).filaments[0].key;
		expect(await status(async () => await addSpool(db, id, 'viewer', key, { kg: 1 }))).toBe(403);
		expect(await status(async () => await addSpool(db, id, 'nobody', key, { kg: 1 }))).toBe(404);
		expect(await status(async () => await addSpool(db, id, 'editor', key, { kg: 1 }))).toBe(0);
		const add = (await view(id)).filaments[0].spoolAdds![0].id;
		expect(await status(async () => await removeSpoolAdd(db, id, 'viewer', key, add))).toBe(403);
		const draft = await mk('draft');
		const dkey = (await view(draft)).filaments[0].key;
		expect(await status(async () => await addSpool(db, draft, 'owner', dkey, { kg: 1 }))).toBe(400);
		expect((await view(draft)).filaments[0].spoolAdds).toEqual([]);
	});

	it('404s for an unknown or prototype-key color', async () => {
		const id = await mk();
		for (const role of ['nope', 'constructor', '__proto__', 'toString']) {
			expect(await status(async () => await addSpool(db, id, 'owner', role, { kg: 1 }))).toBe(404);
			expect(await status(async () => await removeSpoolAdd(db, id, 'owner', role, 'x'))).toBe(404);
		}
	});

	it('survives a design apply and a starting-spools edit; removal reports the stock total', async () => {
		const id = await mk();
		const f0 = (await view(id)).filaments[0];
		await addSpool(db, id, 'owner', f0.key, { kg: 2 });
		await updateBuildDesign(db, id, 'owner', {
			palette: {
				label: 'Test',
				slots: { [f0.key]: { name: 'Other', material: f0.material, hex: '#123456' } }
			}
		});
		let f = (await view(id)).filaments.find((x) => x.key === f0.key)!;
		expect(f.name).toBe('Other');
		expect(f.spoolAdds).toHaveLength(1);
		await updateFilament(db, id, 'owner', f0.key, { spools: 3.5 });
		f = (await view(id)).filaments.find((x) => x.key === f0.key)!;
		expect(f.spools).toBe(3.5);
		expect(stockKg(f)).toBe(5.5);
		const row = (await acts(id, 'filament.spools')).at(-1)!;
		const v = await view(id);
		expect(describeActivity({ ...v.activity[0] }, v)).toMatch(/starting spools to 3\.5 kg$/);
		expect(row.payload).toMatchObject({ spools: 3.5 });
	});

	it('removing a custom color records its whole stock', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'extra', name: 'Extra', material: 'PETG', hex: '#abcdef' }
		});
		await updateFilament(db, id, 'owner', 'extra', { spools: 1 });
		await addSpool(db, id, 'owner', 'extra', { kg: 2 });
		await updateBuildDesign(db, id, 'owner', { removeRole: 'extra' });
		const row = (await acts(id, 'design.update')).at(-1)!;
		expect((row.payload.removed as { spools: number }).spools).toBe(3);
	});
});
