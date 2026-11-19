import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { describeActivity } from '#lib/domain/activity.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildFilaments,
	buildPlates,
	builds,
	colorDesigns,
	member,
	organization,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { createBuild } from '../builds/create';
import { loadBuildView } from '../builds/view';
import { onBuildEvents } from '../builds/test-helpers';
import {
	createDesign,
	deleteDesign,
	findDesign,
	getDesignDetail,
	listDesigns,
	saveSnapshot,
	updateDesignMeta
} from './designs';
import { applyDesignToBuild, updateBuildDesign } from './mutate';
import { shareDesign } from './gallery';

let db: Db;
let templateId: string;
const orgId = 'org1';

async function addUser(id: string) {
	await db
		.insert(user)
		.values({ id, name: `User ${id}`, email: `${id}@example.test`, createdAt: new Date() });
}
async function addMember(org: string, u: string, role: string) {
	await db
		.insert(member)
		.values({ id: `m-${org}-${u}`, organizationId: org, userId: u, role, createdAt: new Date() });
}

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	for (const [id, slug] of [
		[orgId, 'chapter'],
		['org2', 'other']
	])
		await db.insert(organization).values({ id, name: slug, slug, createdAt: new Date() });
	for (const [u, role] of [
		['owner', 'owner'],
		['editor', 'editor'],
		['viewer', 'viewer']
	]) {
		await addUser(u);
		await addMember(orgId, u, role);
	}
	await addUser('outsider');
	await addMember('org2', 'outsider', 'owner');
});

const mk = (designId: string | null = null, org = orgId, u = 'owner') =>
	createBuild(db, { organizationId: org, templateId, designId, name: 'B' }, u);
const view = async (id: string, u = 'owner') => (await loadBuildView(db, id, u))!;
const last = (v: Awaited<ReturnType<typeof view>>, kind: string) =>
	v.activity.find((a) => a.kind === kind)!;
const code = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiError) return e.status;
		throw e;
	}
	return 0;
};

afterEach(() => dropTestDb(db));

describe('updateBuildDesign', () => {
	it('lets an editor move parts, persists, logs and emits', async () => {
		const id = await mk();
		const ev = onBuildEvents(id);
		const before = await view(id, 'editor');
		const accent = before.filaments.find((f) => f.key === 'accent')!;
		expect(before.allParts.find((p) => p.slug === 'wing-left')!.role).not.toBe('primary');
		await updateBuildDesign(db, id, 'editor', {
			partRoles: { 'wing-left': 'primary', 'wing-right': 'primary' }
		});
		const after = await view(id, 'editor');
		expect(after.allParts.find((p) => p.slug === 'wing-left')!.role).toBe('primary');
		expect(after.allParts.find((p) => p.slug === 'wing-right')!.role).toBe('primary');
		const row = (await db.select().from(activity).where(eq(activity.buildId, id))).at(-1)!;
		expect(row.kind).toBe('design.update');
		expect(ev.some((e) => e.kind === 'design.update')).toBe(true);
		expect(describeActivity(last(after, 'design.update'), after)).toBe(
			'User editor moved Wing Left and Wing Right to ' +
				before.filaments.find((f) => f.key === 'primary')!.name
		);
		expect(accent.key).toBe('accent');
	});

	it('refuses viewers, outsiders, unknown parts and roles, and the wrong material', async () => {
		const id = await mk();
		const body = { partRoles: { 'wing-left': 'primary' } };
		expect(await code(() => updateBuildDesign(db, id, 'viewer', body))).toBe(403);
		expect(await code(() => updateBuildDesign(db, id, 'outsider', body))).toBe(404);
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { partRoles: { nope: 'primary' } }))
		).toBe(400);
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'ghost' } }))
		).toBe(400);
		// wing-left is PETG-only, "soft" is TPU
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'soft' } }))
		).toBe(400);
		expect(await code(() => updateBuildDesign(db, id, 'owner', {}))).toBe(400);
		// no-op move
		const cur = (await view(id)).allParts.find((p) => p.slug === 'wing-left')!.role;
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': cur } }))
		).toBe(400);
	});

	it('adds a color and removes it once nothing uses it', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { name: 'Polymaker Red', material: 'PETG', hex: '#C0281E' }
		});
		let v = await view(id);
		const red = v.filaments.at(-1)!;
		expect(red).toMatchObject({
			key: 'polymaker-red',
			hex: '#c0281e',
			spools: 0,
			tpu: false,
			kit: false
		});
		expect(describeActivity(last(v, 'design.update'), v)).toBe(
			'User owner added a color: Polymaker Red'
		);
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': red.key } });
		v = await view(id);
		expect(v.parts.find((p) => p.slug === 'wing-left')!.role).toBe('polymaker-red');
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'accent' } });
		await updateBuildDesign(db, id, 'owner', { removeRole: 'polymaker-red' });
		expect((await view(id)).filaments.some((f) => f.key === 'polymaker-red')).toBe(false);
		expect(await code(() => updateBuildDesign(db, id, 'owner', { removeRole: 'zzz' }))).toBe(404);
	});

	it('adds a color and moves a part to it in one call; TPU colors only take TPU parts', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'flex', name: 'Flex Pink', material: 'TPU 95A', hex: '#ff66aa' },
			partRoles: { 'soft-headrest': 'flex' }
		});
		const v = await view(id);
		expect(v.filaments.find((f) => f.key === 'flex')!.tpu).toBe(true);
		expect(v.allParts.find((p) => p.slug === 'soft-headrest')!.role).toBe('flex');
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'flex' } }))
		).toBe(400);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', {
					addRole: { key: 'flex', name: 'x', material: 'PLA', hex: '#000000' }
				})
			)
		).toBe(409);
	});
});

describe('designs', () => {
	it('parallel saves of the same name by different people all succeed, each with its own slug', async () => {
		const own = await mk();
		const other = await mk(null, 'org2', 'outsider');
		const savers: [string, string][] = [
			['owner', own],
			['editor', own],
			['outsider', other]
		];
		// Several rounds: without the slug lock, two of them pick the same free slug and one insert fails.
		for (const name of ['Sunrise', 'Dusk', 'Tide', 'Moss', 'Ember']) {
			const made = await Promise.all(
				savers.map(([u, buildId]) => createDesign(db, u, { buildId, name }))
			);
			const slugs = made.map((m) => m.slug);
			expect(new Set(slugs).size).toBe(savers.length);
			expect(slugs).toContain(name.toLowerCase());
		}
	});

	it('saves a build as a design with full roles, and builds from it', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
			partRoles: { 'wing-left': 'red', 'wing-right': 'red' }
		});
		const made = await createDesign(db, 'owner', { buildId: id, name: 'My Reds!' });
		expect(made.slug).toBe('my-reds');
		// the outsider (another team) can use it once it is shared to the gallery
		await shareDesign(db, made.id, 'owner');
		const d = await findDesign(db, made.slug, 'outsider');
		expect(d.roles.map((r) => r.key)).toContain('red');
		expect(d.partRoles['wing-left']).toBe('red');
		expect(Object.keys(d.partRoles).length).toBe((await view(id)).allParts.length);

		const b2 = await mk(d.id, 'org2', 'outsider');
		const v2 = await view(b2, 'outsider');
		expect(v2.filaments.find((f) => f.key === 'red')).toMatchObject({
			name: 'Red',
			hex: '#aa0000'
		});
		expect(v2.parts.find((p) => p.slug === 'wing-right')!.role).toBe('red');
	});

	it('saving and renaming never set the seeded-example marker', async () => {
		const id = await mk();
		const d = await createDesign(db, 'owner', { buildId: id, name: 'Mine', isPublic: true });
		await updateDesignMeta(db, d.id, 'owner', { name: 'Mine 2', isPublic: true });
		const row = await db.select().from(colorDesigns).where(eq(colorDesigns.id, d.id));
		expect(row[0].isPublic).toBe(false);
	});

	it('only editors can save; names are required; slugs stay unique', async () => {
		const id = await mk();
		expect(await code(() => createDesign(db, 'viewer', { buildId: id, name: 'x' }))).toBe(403);
		expect(await code(() => createDesign(db, 'outsider', { buildId: id, name: 'x' }))).toBe(404);
		expect(await code(() => createDesign(db, 'owner', { buildId: id, name: '  ' }))).toBe(400);
		const a = await createDesign(db, 'owner', { buildId: id, name: 'Same' });
		const b = await createDesign(db, 'owner', { buildId: id, name: 'Same' });
		expect(a.slug).not.toBe(b.slug);
	});

	it('visibility: author, people who share a workspace with the author, and the seeded examples', async () => {
		const id = await mk();
		const priv = await createDesign(db, 'owner', { buildId: id, name: 'Private one' });
		const pub = await createDesign(db, 'owner', { buildId: id, name: 'Public one' });
		// the retired isPublic column grants nothing
		await db.update(colorDesigns).set({ isPublic: true }).where(eq(colorDesigns.id, pub.id));
		const names = async (u: string) => (await listDesigns(db, u)).map((d) => d.name);
		expect(await names('owner')).toEqual(expect.arrayContaining(['Private one', 'Public one']));
		// editor shares the team with the author
		expect(await names('editor')).toEqual(expect.arrayContaining(['Private one', 'Public one']));
		const out = await names('outsider');
		expect(out).not.toContain('Public one');
		expect(out).not.toContain('Private one');
		expect(await code(() => findDesign(db, priv.id, 'outsider'))).toBe(404);
		expect(await code(() => findDesign(db, pub.slug, 'outsider'))).toBe(404);
		// seeded example designs have no author and are open to every signed-in user
		expect(out).toContain('Columbus #4691 Blues');
		const detail = await getDesignDetail(db, pub.slug, 'editor');
		expect(detail.parts.length).toBe((await view(id)).allParts.length);
		expect(detail.authorName).toBe('User owner');
		expect(Object.values(detail.partCounts).reduce((a, b) => a + b, 0)).toBe(detail.parts.length);
	});

	it('only the author renames or deletes', async () => {
		const id = await mk();
		const d = await createDesign(db, 'owner', { buildId: id, name: 'Mine' });
		expect(await code(() => updateDesignMeta(db, d.id, 'editor', { name: 'Hijack' }))).toBe(403);
		await updateDesignMeta(db, d.id, 'owner', { name: 'Renamed' });
		expect(
			await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, d.id)))
		).toMatchObject({
			name: 'Renamed'
		});
		expect(
			await deleteDesign(db, d.id, 'editor').then(
				() => 0,
				(e: ApiError) => e.status
			)
		).toBe(403);
		await deleteDesign(db, d.id, 'owner');
		expect(await code(() => findDesign(db, d.id, 'owner'))).toBe(404);
		// a build made from it keeps its snapshot
		expect((await view(id)).allParts.length).toBeGreaterThan(0);
	});

	it('accepts only PNG previews from the author', async () => {
		const id = await mk();
		const d = await createDesign(db, 'owner', { buildId: id, name: 'Pic' });
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const run = (u: string, bytes: Uint8Array) =>
			saveSnapshot(db, d.id, u, bytes).then(
				() => 0,
				(e: ApiError) => e.status
			);
		expect(await run('owner', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(400);
		expect(await run('owner', new Uint8Array(3 * 1024 * 1024))).toBe(413);
		expect(await run('editor', png)).toBe(403);
		expect(await run('owner', png)).toBe(0);
		expect((await listDesigns(db, 'owner')).find((x) => x.id === d.id)!.hasSnapshot).toBe(true);
		await deleteDesign(db, d.id, 'owner');
	});
});

describe('applyDesignToBuild', () => {
	it('replaces roles and parts, keeps spools, logs design.apply', async () => {
		const src = await mk();
		await updateBuildDesign(db, src, 'owner', {
			addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
			partRoles: { 'wing-left': 'red' }
		});
		await db
			.update(buildFilaments)
			.set({ name: 'Custom Primary', hex: '#123456' })
			.where(and(eq(buildFilaments.buildId, src), eq(buildFilaments.roleKey, 'primary')));
		const d = await createDesign(db, 'owner', { buildId: src, name: 'Source' });

		const target = await mk();
		await db.update(buildFilaments).set({ spools: 7 }).where(eq(buildFilaments.buildId, target));
		expect(await code(() => applyDesignToBuild(db, d.id, target, 'viewer'))).toBe(403);
		expect(await code(() => applyDesignToBuild(db, d.id, target, 'outsider'))).toBe(404);
		const ev = onBuildEvents(target);
		await applyDesignToBuild(db, d.id, target, 'editor');
		const v = await view(target);
		expect(v.filaments.find((f) => f.key === 'primary')).toMatchObject({
			name: 'Custom Primary',
			hex: '#123456',
			spools: 7
		});
		expect(v.filaments.find((f) => f.key === 'red')).toMatchObject({ hex: '#aa0000', spools: 0 });
		expect(v.parts.find((p) => p.slug === 'wing-left')!.role).toBe('red');
		expect(describeActivity(last(v, 'design.apply'), v)).toBe(
			'User editor applied the color design "Source" (colors and part colors replaced)'
		);
		expect(ev.some((e) => e.kind === 'design.apply')).toBe(true);
		expect(
			(
				(await first(db.select().from(builds).where(eq(builds.id, target))))!.design as {
					id: string;
				}
			).id
		).toBe(d.id);
	});

	it('refuses a design the user cannot see', async () => {
		const src = await mk();
		const d = await createDesign(db, 'owner', { buildId: src, name: 'Hidden' });
		const other = await mk(null, 'org2', 'outsider');
		expect(await code(() => applyDesignToBuild(db, d.id, other, 'outsider'))).toBe(404);
	});
});

const addRed = (id: string, extra: Record<string, unknown> = {}) =>
	updateBuildDesign(db, id, 'owner', {
		addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
		...extra
	});
const lockedOf = async (id: string) =>
	(await view(id)).allParts
		.filter((p) => p.locked)
		.map((p) => p.slug)
		.sort();
const rolesOfBuild = async (id: string) =>
	Object.fromEntries((await view(id)).allParts.map((p) => [p.slug, p.role]));
const activityCount = async (id: string) =>
	(await db.select().from(activity).where(eq(activity.buildId, id))).length;

describe('removing a color that is in use', () => {
	it('needs a replacement: 409 without one, 400 for the kit, an unknown slot or itself', async () => {
		const id = await mk();
		await addRed(id, { partRoles: { 'wing-left': 'red' } });
		expect(await code(() => updateBuildDesign(db, id, 'owner', { removeRole: 'red' }))).toBe(409);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', { removeRole: 'red', replaceWith: 'red' })
			)
		).toBe(400);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', { removeRole: 'red', replaceWith: 'nope' })
			)
		).toBe(400);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', { removeRole: 'primary', replaceWith: 'red' })
			)
		).toBe(400);
		expect(await code(() => updateBuildDesign(db, id, 'owner', { replaceWith: 'primary' }))).toBe(
			400
		);
		expect((await view(id)).filaments.some((f) => f.key === 'red')).toBe(true);
	});

	it('names the parts a replacement cannot take (material) and changes nothing', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'flex', name: 'Flex Pink', material: 'TPU 95A', hex: '#ff66aa' },
			partRoles: { 'soft-headrest': 'flex' }
		});
		const n = await activityCount(id);
		let msg = '';
		try {
			await updateBuildDesign(db, id, 'owner', { removeRole: 'flex', replaceWith: 'primary' });
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			expect((e as ApiError).status).toBe(400);
			msg = (e as ApiError).message;
		}
		expect(msg).toMatch(/Soft Headrest/);
		expect((await rolesOfBuild(id))['soft-headrest']).toBe('flex');
		expect(await activityCount(id)).toBe(n);
		await updateBuildDesign(db, id, 'owner', { removeRole: 'flex', replaceWith: 'soft' });
		expect((await rolesOfBuild(id))['soft-headrest']).toBe('soft');
	});

	it('moves every part (hidden variants too, locks kept), drops spools, remaps grams, logs it', async () => {
		const id = await mk();
		await addRed(id, { partRoles: { 'wing-left': 'red', 'footrest-front': 'red' } });
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['wing-left'], locked: true } });
		await db
			.update(buildFilaments)
			.set({ spools: 2 })
			.where(and(eq(buildFilaments.buildId, id), eq(buildFilaments.roleKey, 'red')));
		await db
			.insert(buildPlates)
			.values({ buildId: id, number: 90, name: 'P', filamentGrams: { red: 10, primary: 5 } });
		expect((await view(id)).parts.some((p) => p.slug === 'footrest-front')).toBe(false);
		const ev = onBuildEvents(id);
		const n = await activityCount(id);
		await updateBuildDesign(db, id, 'editor', { removeRole: 'red', replaceWith: 'primary' });
		const v = await view(id);
		expect(v.filaments.some((f) => f.key === 'red')).toBe(false);
		expect(
			await db
				.select()
				.from(buildFilaments)
				.where(and(eq(buildFilaments.buildId, id), eq(buildFilaments.roleKey, 'red')))
		).toEqual([]);
		expect(await rolesOfBuild(id)).toMatchObject({
			'wing-left': 'primary',
			'footrest-front': 'primary'
		});
		expect(await lockedOf(id)).toEqual(['wing-left']);
		expect(
			(await first(
				db
					.select()
					.from(buildPlates)
					.where(and(eq(buildPlates.buildId, id), eq(buildPlates.number, 90)))
			))!.filamentGrams
		).toEqual({ primary: 15 });
		expect(await activityCount(id)).toBe(n + 1);
		expect(ev.at(-1)!.kind).toBe('design.update');
		const text = describeActivity(last(v, 'design.update'), v);
		expect(text).toContain(
			'removed Red PETG; its 2 parts now use Primary PETG and dropped 2 spools of stock'
		);
		expect(text).toContain('dropped 2 spools of stock');
	});

	it('works on a Studio draft and not for viewers', async () => {
		const id = await createBuild(
			db,
			{ organizationId: orgId, templateId, designId: null, name: 'D', kind: 'draft' },
			'owner'
		);
		await addRed(id, { partRoles: { 'wing-left': 'red' } });
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'viewer', { removeRole: 'red', replaceWith: 'primary' })
			)
		).toBe(403);
		await updateBuildDesign(db, id, 'editor', { removeRole: 'red', replaceWith: 'accent' });
		expect((await rolesOfBuild(id))['wing-left']).toBe('accent');
		expect((await view(id)).filaments.some((f) => f.key === 'red')).toBe(false);
	});
});

describe('Lock part color', () => {
	it('locks and unlocks parts, logs part names, and ignores a repeat', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'editor', {
			lock: { slugs: ['wing-left', 'wing-right'], locked: true }
		});
		expect(await lockedOf(id)).toEqual(['wing-left', 'wing-right']);
		let v = await view(id);
		expect(describeActivity(last(v, 'design.update'), v)).toBe(
			'User editor locked the part color of Wing Left and Wing Right'
		);
		const n = await activityCount(id);
		await updateBuildDesign(db, id, 'editor', { lock: { slugs: ['wing-left'], locked: true } });
		expect(await activityCount(id)).toBe(n);
		await updateBuildDesign(db, id, 'editor', { lock: { slugs: ['wing-left'], locked: false } });
		expect(await lockedOf(id)).toEqual(['wing-right']);
		v = await view(id);
		expect(describeActivity(last(v, 'design.update'), v)).toBe(
			'User editor unlocked the part color of Wing Left'
		);
		// the roles and filaments survive a lock write
		expect(v.filaments).toHaveLength(4);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'viewer', { lock: { slugs: ['x'], locked: true } })
			)
		).toBe(403);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', { lock: { slugs: ['nope'], locked: true } })
			)
		).toBe(400);
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { lock: { slugs: [], locked: true } }))
		).toBe(400);
		expect(
			await code(() => updateBuildDesign(db, id, 'owner', { lock: { slugs: ['wing-left'] } }))
		).toBe(400);
	});

	it('locks only the listed part, never its symmetry peer, and a palette adds at most one slot', async () => {
		const id = await mk();
		// Wing Left and Wing Right share a symmetry group but sit on different slots.
		await updateBuildDesign(db, id, 'owner', {
			partRoles: { 'wing-left': 'primary', 'wing-right': 'accent' }
		});
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['wing-left'], locked: true } });
		expect(await lockedOf(id)).toEqual(['wing-left']);
		const v = await view(id);
		expect(describeActivity(last(v, 'design.update'), v)).toBe(
			'User owner locked the part color of Wing Left'
		);
		await updateBuildDesign(db, id, 'owner', {
			palette: {
				label: 'Sunset',
				reset: true,
				slots: {
					primary: { name: 'Sun Orange', material: 'PETG', hex: '#ff8800' },
					accent: { name: 'Sun Red', material: 'PETG', hex: '#cc2200' }
				}
			}
		});
		expect((await view(id)).filaments).toHaveLength(5);
		expect(await lockedOf(id)).toEqual(['wing-left']);
		expect((await rolesOfBuild(id))['wing-right']).toBe('accent');
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['wing-left'], locked: false } });
		expect(await lockedOf(id)).toEqual([]);
	});

	it('a locked part can still be moved by hand', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['wing-left'], locked: true } });
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'primary' } });
		expect((await rolesOfBuild(id))['wing-left']).toBe('primary');
		expect(await lockedOf(id)).toEqual(['wing-left']);
	});

	it('Apply this design keeps the locks (a locked part keeps its slot)', async () => {
		const id = await mk();
		const d = await createDesign(db, 'owner', { buildId: id, name: 'Same' });
		await updateBuildDesign(db, id, 'owner', {
			lock: { slugs: ['wing-left', 'seat-center'], locked: true }
		});
		const before = await rolesOfBuild(id);
		await applyDesignToBuild(db, d.id, id, 'owner');
		expect(await lockedOf(id)).toEqual(['seat-center', 'wing-left']);
		expect((await rolesOfBuild(id))['wing-left']).toBe(before['wing-left']);
		expect(
			(
				(
					(await first(db.select().from(builds).where(eq(builds.id, id))))!.design as Record<
						string,
						unknown
					>
				).lockedParts as string[]
			).sort()
		).toEqual(['seat-center', 'wing-left']);
	});
});

describe('applying a palette in one call', () => {
	const pal = (reset = true) => ({
		palette: {
			label: 'Sunset',
			reset,
			slots: {
				primary: { name: 'Sun Orange', material: 'PETG', hex: '#ff8800' },
				accent: { name: 'Sun Red', material: 'PETG', hex: '#cc2200' }
			}
		}
	});

	it('sets the filaments and sends every unlocked part back to its kit slot, as one activity row', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
			partRoles: { 'wing-left': 'red', 'seat-center': 'accent', 'push-top': 'primary' }
		});
		const ev = onBuildEvents(id);
		const n = await activityCount(id);
		await updateBuildDesign(db, id, 'editor', pal());
		const v = await view(id);
		expect(await activityCount(id)).toBe(n + 1);
		expect(ev).toHaveLength(1);
		expect((await db.select().from(activity).where(eq(activity.buildId, id))).at(-1)!.kind).toBe(
			'design.update'
		);
		expect(v.filaments.find((f) => f.key === 'primary')).toMatchObject({
			name: 'Sun Orange',
			hex: '#ff8800'
		});
		expect(v.allParts.every((p) => p.role === p.defaultRole)).toBe(true);
		const text = describeActivity(last(v, 'design.update'), v);
		expect(text).toContain('applied the Sunset palette; 3 parts back to their kit colors');
	});

	it('keeps locked parts on their exact color by moving them to a slot that holds it', async () => {
		const id = await mk();
		const before = await view(id);
		const oldPrimary = before.filaments.find((f) => f.key === 'primary')!;
		const oldAccent = before.filaments.find((f) => f.key === 'accent')!;
		await updateBuildDesign(db, id, 'owner', {
			partRoles: { 'wing-right': 'primary' },
			lock: { slugs: ['wing-left', 'seat-center', 'wing-right'], locked: true }
		});
		await updateBuildDesign(db, id, 'owner', pal());
		const v = await view(id);
		const roles = await rolesOfBuild(id);
		// wing-left was on accent, seat-center on primary, wing-right (locked) on primary: all keep the old color
		const slotOf = (slug: string) => v.filaments.find((f) => f.key === roles[slug])!;
		expect(slotOf('wing-left')).toMatchObject({
			name: oldAccent.name,
			hex: oldAccent.hex,
			kit: false
		});
		expect(slotOf('seat-center')).toMatchObject({
			name: oldPrimary.name,
			hex: oldPrimary.hex,
			kit: false
		});
		expect(roles['wing-right']).toBe(roles['seat-center']);
		expect(v.filaments).toHaveLength(6);
		expect(await lockedOf(id)).toEqual(['seat-center', 'wing-left', 'wing-right']);
		const text = describeActivity(last(v, 'design.update'), v);
		expect(text).toContain('3 locked parts kept');
		expect(text).toContain('on a new color slot');
		// the same palette again changes nothing about the locked parts and adds no slot
		await updateBuildDesign(db, id, 'owner', {
			palette: {
				label: 'Again',
				reset: true,
				slots: { primary: { name: 'Other', material: 'PETG', hex: '#010203' } }
			}
		});
		expect((await view(id)).filaments).toHaveLength(6);
		expect((await rolesOfBuild(id))['seat-center']).toBe(roles['seat-center']);
	});

	it('reuses an existing non-kit slot that already holds the locked color', async () => {
		const id = await mk();
		const primary = (await view(id)).filaments.find((f) => f.key === 'primary')!;
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'same', name: primary.name, material: primary.material, hex: primary.hex },
			lock: { slugs: ['seat-center'], locked: true }
		});
		await updateBuildDesign(db, id, 'owner', pal());
		expect((await rolesOfBuild(id))['seat-center']).toBe('same');
		expect((await view(id)).filaments.map((f) => f.key).sort()).toEqual([
			'accent',
			'primary',
			'same',
			'soft',
			'tire'
		]);
		const v = await view(id);
		expect(describeActivity(last(v, 'design.update'), v)).not.toContain('new color slot');
	});

	it('leaves a locked part alone when its slot keeps the same filament', async () => {
		const id = await mk();
		const primary = (await view(id)).filaments.find((f) => f.key === 'primary')!;
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['seat-center'], locked: true } });
		await updateBuildDesign(db, id, 'owner', {
			palette: {
				label: 'Same',
				reset: true,
				slots: { primary: { name: primary.name, material: primary.material, hex: primary.hex } }
			}
		});
		expect((await rolesOfBuild(id))['seat-center']).toBe('primary');
		expect((await view(id)).filaments).toHaveLength(4);
	});

	it('Undo: one call restores filaments, part colors and removes the auto-added slots', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			partRoles: { 'wing-right': 'primary' },
			lock: { slugs: ['wing-left'], locked: true }
		});
		const before = await view(id);
		const slots = Object.fromEntries(
			before.filaments
				.filter((f) => f.kit)
				.map((f) => [f.key, { name: f.name, material: f.material, hex: f.hex }])
		);
		const beforeRoles = await rolesOfBuild(id);
		const keys = new Set(before.filaments.map((f) => f.key));
		await updateBuildDesign(db, id, 'owner', pal());
		const added = (await view(id)).filaments.map((f) => f.key).filter((k) => !keys.has(k));
		expect(added).toHaveLength(1);
		const n = await activityCount(id);
		await updateBuildDesign(db, id, 'owner', {
			palette: { label: 'earlier', slots },
			partRoles: beforeRoles,
			removeRoles: added
		});
		expect(await activityCount(id)).toBe(n + 1);
		const after = await view(id);
		expect(await rolesOfBuild(id)).toEqual(beforeRoles);
		const shape = (v: typeof after) =>
			v.filaments.map((f) => [f.key, f.name, f.material, f.hex.toLowerCase()]).sort();
		expect(shape(after)).toEqual(shape(before));
		expect(await lockedOf(id)).toEqual(['wing-left']);
		// removeRoles only takes slots nothing uses
		expect(await code(() => updateBuildDesign(db, id, 'owner', { removeRoles: ['primary'] }))).toBe(
			409
		);
	});

	it('works on drafts, is refused for viewers, and validates the body', async () => {
		const id = await createBuild(
			db,
			{ organizationId: orgId, templateId, designId: null, name: 'D', kind: 'draft' },
			'owner'
		);
		expect(await code(() => updateBuildDesign(db, id, 'viewer', pal()))).toBe(403);
		expect(await code(() => updateBuildDesign(db, id, 'owner', { palette: { slots: {} } }))).toBe(
			400
		);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', {
					palette: { label: 'x', slots: { ghost: { name: 'a', material: 'PETG', hex: '#000000' } } }
				})
			)
		).toBe(400);
		expect(
			await code(() =>
				updateBuildDesign(db, id, 'owner', {
					palette: { label: 'x', slots: { primary: { name: 'a', material: 'PETG', hex: 'red' } } }
				})
			)
		).toBe(400);
		await updateBuildDesign(db, id, 'editor', pal());
		expect((await view(id)).filaments.find((f) => f.key === 'accent')!.hex).toBe('#cc2200');
	});
});
