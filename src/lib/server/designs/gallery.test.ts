import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { colorDesigns, member, organization, siteAdmin, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { findDesign, getDesignDetail, listDesigns } from './designs';
import { canViewTemplate } from '../templates/fork';
import {
	copiedFromCredit,
	copyGalleryDesign,
	findSharedDesign,
	getGalleryItem,
	liftGalleryHide,
	listGallery,
	publicSharerName,
	shareDesign,
	SHARES_PER_DAY,
	unshareDesign
} from './gallery';

let db: Db;
let templateId: string;

const roles = (hex = '#C0281E') => [
	{ key: 'primary', name: 'Polymaker Red', material: 'PETG', hex },
	{ key: 'accent', name: 'Black', material: 'PETG', hex: '#111111' }
];

async function addUser(id: string, name = `User ${id}`, email = `${id}@example.test`) {
	await db.insert(user).values({ id, name, email, createdAt: new Date() });
}

let n = 0;
async function addDesign(author: string, name = 'Design', hex?: string) {
	n += 1;
	const [row] = await db
		.insert(colorDesigns)
		.values({
			templateId,
			slug: `d${n}`,
			name,
			authorUserId: author,
			roles: roles(hex),
			partRoles: {}
		})
		.returning();
	return row;
}

const status = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiError) return e.status;
		throw e;
	}
	return 0;
};
const cand = (id: string) => ({ id, email: `${id}@example.test`, emailVerified: true });

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db.insert(organization).values({ id: 'o1', name: 'T1', slug: 't1', createdAt: new Date() });
	await db.insert(organization).values({ id: 'o2', name: 'T2', slug: 't2', createdAt: new Date() });
	await addUser('alice', 'Alice Maker', 'alice.private@example.test');
	await addUser('bob', 'bob@example.test');
	await addUser('carol');
	await addUser('admin');
	await db.insert(member).values([
		{ id: 'm1', organizationId: 'o1', userId: 'alice', role: 'owner', createdAt: new Date() },
		{ id: 'm2', organizationId: 'o2', userId: 'bob', role: 'owner', createdAt: new Date() },
		{ id: 'm3', organizationId: 'o2', userId: 'carol', role: 'viewer', createdAt: new Date() }
	]);
	await db.insert(siteAdmin).values({ userId: 'admin', grantedBy: null });
});
afterEach(() => dropTestDb(db));

describe('who sees what', () => {
	it('shows an unshared design only to its author and teammates, a shared one to every signed-in user', async () => {
		const d = await addDesign('alice', 'Sunrise');
		expect(await status(() => findDesign(db, d.id, 'bob'))).toBe(404);
		expect(await status(() => findSharedDesign(db, d.id))).toBe(404);
		expect(await listGallery(db, 'bob')).toMatchObject({ total: 0, items: [] });
		await shareDesign(db, d.id, 'alice');
		expect(await status(() => findDesign(db, d.id, 'bob'))).toBe(0);
		expect((await getDesignDetail(db, d.slug, 'bob')).shared).toBe(true);
		const g = await listGallery(db, 'bob');
		expect(g.items.map((i) => i.name)).toEqual(['Sunrise']);
		// the Designs page list is unchanged: gallery designs are not mixed in
		expect((await listDesigns(db, 'bob')).map((x) => x.id)).not.toContain(d.id);
	});

	it('never leaks an email or the team, only a display name', async () => {
		const d = await addDesign('alice', 'Sunrise');
		await shareDesign(db, d.id, 'alice');
		const item = await getGalleryItem(db, d.id, 'bob');
		expect(item.sharerName).toBe('Alice Maker');
		expect(JSON.stringify(item)).not.toMatch(/example\.test|@|T1|o1/);
		expect(publicSharerName('jane.doe@corp.example')).toBe('jane');
		expect(publicSharerName('')).toBe('A maker');
		expect(publicSharerName(null)).toBe('A maker');
	});
});

describe('share and unshare', () => {
	it('only the author shares; sharing twice is harmless', async () => {
		const d = await addDesign('alice');
		expect(await status(() => shareDesign(db, d.id, 'bob'))).toBe(404);
		// the retired isPublic column grants nothing: sharing has one meaning, the gallery
		await db.update(colorDesigns).set({ isPublic: true }).where(eq(colorDesigns.id, d.id));
		expect(await status(() => shareDesign(db, d.id, 'bob'))).toBe(404);
		await shareDesign(db, d.id, 'alice');
		const at = (await findSharedDesign(db, d.id)).sharedAt;
		await shareDesign(db, d.id, 'alice');
		expect((await findSharedDesign(db, d.id)).sharedAt).toEqual(at);
	});

	it('a demo account may not share, but may copy from the gallery into its own account', async () => {
		await db.insert(user).values({
			id: 'demo1',
			name: 'Demo',
			email: 'demo1@example.test',
			createdAt: new Date(),
			isDemo: true
		});
		const own = await addDesign('demo1', 'Demo colors');
		expect(await status(() => shareDesign(db, own.id, 'demo1'))).toBe(403);
		expect((await findDesign(db, own.id, 'demo1')).sharedAt).toBeNull();
		const d = await addDesign('alice', 'Shared');
		await shareDesign(db, d.id, 'alice');
		expect((await listGallery(db, 'demo1')).items.map((i) => i.name)).toEqual(['Shared']);
		const c = await copyGalleryDesign(db, d.id, 'demo1');
		expect(await findDesign(db, c.id, 'demo1')).toMatchObject({
			authorUserId: 'demo1',
			isPublic: false,
			sharedAt: null
		});
	});

	it('the author unshares; strangers cannot', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		expect(await status(() => unshareDesign(db, d.id, cand('carol')))).toBe(404);
		expect(await unshareDesign(db, d.id, cand('alice'))).toEqual({ hiddenByAdmin: false });
		expect(await status(() => findSharedDesign(db, d.id))).toBe(404);
		// private again for others
		expect(await status(() => findDesign(db, d.id, 'bob'))).toBe(404);
	});

	it('a site admin can hide any shared design and it is logged', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await unshareDesign(db, d.id, cand('admin'))).toEqual({ hiddenByAdmin: true });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`design ${d.id} hidden`));
		warn.mockRestore();
		expect(await status(() => findSharedDesign(db, d.id))).toBe(404);
	});

	it('limits sharing per person per day', async () => {
		const rows: Awaited<ReturnType<typeof addDesign>>[] = [];
		for (let i = 0; i <= SHARES_PER_DAY; i++) rows.push(await addDesign('alice', `D${i}`));
		for (const r of rows.slice(0, SHARES_PER_DAY)) await shareDesign(db, r.id, 'alice');
		expect(await status(() => shareDesign(db, rows[SHARES_PER_DAY].id, 'alice'))).toBe(429);
	});

	it('a design on a team-owned kit copy cannot be shared and does not open the copy', async () => {
		const [copy] = await db
			.insert(templates)
			.values({
				...(await first(db.select().from(templates)))!,
				id: 'tpl-copy',
				slug: 'tpl-copy',
				name: 'Private chair',
				ownerOrgId: 'o1'
			})
			.returning();
		const d = await addDesign('alice');
		await db.update(colorDesigns).set({ templateId: copy.id }).where(eq(colorDesigns.id, d.id));
		expect(await status(() => shareDesign(db, d.id, 'alice'))).toBe(400);
		expect((await listGallery(db, 'bob')).total).toBe(0);
		// Even if a row were shared anyway, it never widens access to the copy.
		await db.update(colorDesigns).set({ sharedAt: new Date() }).where(eq(colorDesigns.id, d.id));
		expect(await canViewTemplate(db, cand('bob'), copy.id)).toBe(false);
		expect(await canViewTemplate(db, cand('alice'), copy.id)).toBe(true);
	});

	it('strangers see the public sharer name and no author id on a shared design', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		const asBob = await getDesignDetail(db, d.id, 'bob');
		expect(asBob.authorUserId).toBeNull();
		expect(asBob.authorName).toBe('Alice Maker');
		const e = await addDesign('bob');
		await shareDesign(db, e.id, 'bob');
		const asAlice = await getDesignDetail(db, e.id, 'alice');
		expect(asAlice.authorUserId).toBeNull();
		expect(asAlice.authorName).toBe('bob');
		const asCarol = await getDesignDetail(db, e.id, 'carol');
		expect(asCarol.authorUserId).toBe('bob');
		expect((await getDesignDetail(db, d.id, 'alice')).authorUserId).toBe('alice');
	});

	it('an admin hide sticks until a site admin lifts it', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await unshareDesign(db, d.id, cand('admin'));
		const row = (await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, d.id))))!;
		expect(row.hiddenFromGalleryAt).not.toBeNull();
		expect(row.hiddenBy).toBe('admin');
		expect(row.sharedAt).toBeNull();
		expect(await status(() => shareDesign(db, d.id, 'alice'))).toBe(403);
		expect(await status(() => liftGalleryHide(db, d.id, cand('bob')))).toBe(404);
		await liftGalleryHide(db, d.id, cand('admin'));
		warn.mockRestore();
		await shareDesign(db, d.id, 'alice');
		expect((await listGallery(db, 'bob')).total).toBe(1);
	});

	it('share and unshare loops still hit the daily limit and do not bump the design', async () => {
		const d = await addDesign('alice', 'Old');
		const e = await addDesign('alice', 'Newer');
		await shareDesign(db, d.id, 'alice');
		await new Promise((r) => setTimeout(r, 5));
		await shareDesign(db, e.id, 'alice');
		await unshareDesign(db, d.id, cand('alice'));
		await shareDesign(db, d.id, 'alice');
		expect((await listGallery(db, 'bob')).items.map((i) => i.name)).toEqual(['Newer', 'Old']);
		let hit = 0;
		for (let i = 0; i < SHARES_PER_DAY && !hit; i++) {
			hit = await status(async () => {
				await unshareDesign(db, d.id, cand('alice'));
				await shareDesign(db, d.id, 'alice');
			});
		}
		expect(hit).toBe(429);
	});

	it('listDesigns returns only own, co-members and seeded designs', async () => {
		const a = await addDesign('alice', 'A');
		await addDesign('bob', 'B');
		const c = await addDesign('carol', 'C');
		await db.update(colorDesigns).set({ authorUserId: null }).where(eq(colorDesigns.id, c.id));
		const mine = async (u: string) =>
			(await listDesigns(db, u))
				.map((x) => x.name)
				.filter((n) => n.length === 1)
				.sort();
		expect(await mine('alice')).toEqual(['A', 'C']);
		expect(await mine('carol')).toEqual(['B', 'C']);
		expect(a.id).toBeTruthy();
	});

	it('deleting a shared design removes it from the gallery and keeps copies', async () => {
		const d = await addDesign('alice', 'Original');
		await shareDesign(db, d.id, 'alice');
		const copy = await copyGalleryDesign(db, d.id, 'bob');
		await db.delete(colorDesigns).where(eq(colorDesigns.id, d.id));
		expect((await listGallery(db, 'carol')).total).toBe(0);
		const kept = await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, copy.id)));
		expect(kept).toMatchObject({ name: 'Original', authorUserId: 'bob', copiedFromDesignId: null });
	});
});

describe('copy ("Use this design")', () => {
	it('makes a private design of the copier that is independent of the original', async () => {
		const d = await addDesign('alice', 'Sunrise');
		expect(await status(() => copyGalleryDesign(db, d.id, 'bob'))).toBe(404); // not shared yet
		await shareDesign(db, d.id, 'alice');
		const c = await copyGalleryDesign(db, d.slug, 'bob');
		const row = (await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, c.id))))!;
		expect(row).toMatchObject({
			authorUserId: 'bob',
			isPublic: false,
			sharedAt: null,
			sharedBy: null,
			copiedFromDesignId: d.id,
			name: 'Sunrise'
		});
		expect(row.roles).toEqual(roles());
		// original unshared or edited: the copy is unaffected, and the credit disappears
		expect(await copiedFromCredit(db, row)).toEqual({
			name: 'Sunrise',
			slug: d.slug,
			sharerName: 'Alice Maker'
		});
		await unshareDesign(db, d.id, cand('alice'));
		expect(await copiedFromCredit(db, row)).toBeNull();
		expect((await findDesign(db, c.id, 'bob')).roles).toEqual(roles());
		// still private from others
		expect(await status(() => findDesign(db, c.id, 'alice'))).toBe(404);
	});

	it('counts other makers, not the sharer or repeats', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		await copyGalleryDesign(db, d.id, 'alice');
		await copyGalleryDesign(db, d.id, 'bob');
		await copyGalleryDesign(db, d.id, 'bob');
		await copyGalleryDesign(db, d.id, 'carol');
		expect((await getGalleryItem(db, d.id, 'bob')).copies).toBe(2);
	});

	it('is stopped by the saved-designs quota', async () => {
		const d = await addDesign('alice');
		await shareDesign(db, d.id, 'alice');
		vi.stubEnv('QUOTA_SAVED_DESIGNS_PER_USER', '1');
		try {
			await copyGalleryDesign(db, d.id, 'bob');
			expect(await status(() => copyGalleryDesign(db, d.id, 'bob'))).toBeGreaterThanOrEqual(400);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('listing', () => {
	it('newest first, searchable by name (wildcards are literal), filterable by color family, paged', async () => {
		const a = await addDesign('alice', 'Red 100%', '#ff0000');
		const b = await addDesign('alice', 'Ocean', '#1e60d2');
		const c = await addDesign('alice', 'Forest', '#2e9e4a');
		for (const [i, r] of [a, b, c].entries()) {
			await shareDesign(db, r.id, 'alice');
			await db
				.update(colorDesigns)
				.set({ sharedAt: new Date(Date.now() - (3 - i) * 60_000) })
				.where(eq(colorDesigns.id, r.id));
		}
		expect((await listGallery(db, 'bob')).items.map((i) => i.name)).toEqual([
			'Forest',
			'Ocean',
			'Red 100%'
		]);
		expect((await listGallery(db, 'bob', { q: 'ocean' })).items.map((i) => i.name)).toEqual([
			'Ocean'
		]);
		expect((await listGallery(db, 'bob', { q: '%' })).items.map((i) => i.name)).toEqual([
			'Red 100%'
		]);
		expect((await listGallery(db, 'bob', { q: '_' })).total).toBe(0);
		expect((await listGallery(db, 'bob', { family: 'blue' })).items.map((i) => i.name)).toEqual([
			'Ocean'
		]);
		expect((await listGallery(db, 'bob', { family: 'nonsense' })).total).toBe(3);
		const p2 = await listGallery(db, 'bob', { pageSize: 2, page: 2 });
		expect(p2).toMatchObject({ total: 3, page: 2, pages: 2 });
		expect(p2.items.map((i) => i.name)).toEqual(['Red 100%']);
		// the page size is capped
		expect((await listGallery(db, 'bob', { pageSize: 5000 })).pageSize).toBe(48);
	});
});
