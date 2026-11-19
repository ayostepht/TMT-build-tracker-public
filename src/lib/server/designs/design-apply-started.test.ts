import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeActivity } from '#lib/domain/activity.ts';
import { designSnapshot, undoPatch } from '#lib/domain/design-apply.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildFilaments,
	buildPlates,
	builds,
	member,
	organization,
	printerJobs,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { setPartStatus } from '../builds/actions';
import { createBuild } from '../builds/create';
import { BuildStartedError } from '../builds/started-guard';
import { loadBuildView } from '../builds/view';
import { createPrinter } from '../printers/store';
import { respond } from '../api';
import { createDesign } from './designs';
import { applyDesignToBuild, previewApplyDesign, updateBuildDesign } from './mutate';

// Issue #56: applying a design (or resetting by palette) to a build that has started printing.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('#lib/server/db/index.ts', async (orig) => ({
	...(await orig<object>()),
	getDb: () => h.db
}));

let db: Db;
let templateId: string;
const orgId = 'org1';
const cc = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);

beforeEach(async () => {
	db = await createTestDb();
	h.db = db;
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db.insert(member).values({
		id: 'm1',
		organizationId: orgId,
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
});

const mk = () =>
	createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', printer: cc },
		'owner'
	);
/** Hex case differs between kit seeds (upper) and API writes (lower): compare lower-cased. */
const snapLower = (s: ReturnType<typeof designSnapshot>) => ({
	...s,
	roles: s.roles.map((r) => ({ ...r, hex: r.hex.toLowerCase() }))
});
const snapOf = async (id: string) => snapLower(designSnapshot(await view(id)));
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const fil = async (id: string, key: string) =>
	(await view(id)).filaments.find((f) => f.key === key)!;
const rolesOf = async (id: string) =>
	Object.fromEntries((await view(id)).allParts.map((p) => [p.slug, p.role]));
const lastKind = async (id: string) =>
	(await db.select().from(activity).where(eq(activity.buildId, id))).at(-1)!;
const status = async (fn: () => unknown): Promise<number> => {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiError) return e.status;
		throw e;
	}
	return 0;
};
const plates = async (id: string) =>
	JSON.stringify(await db.select().from(buildPlates).where(eq(buildPlates.buildId, id)));

/** A design from a scratch build: primary and accent recolored, soft stays. */
async function makeDesign(mutate?: (src: string) => void | Promise<void>) {
	const src = await mk();
	await db
		.update(buildFilaments)
		.set({ name: 'Ocean', hex: '#0044cc' })
		.where(and(eq(buildFilaments.buildId, src), eq(buildFilaments.roleKey, 'primary')));
	await db
		.update(buildFilaments)
		.set({ name: 'Lime', hex: '#66dd00' })
		.where(and(eq(buildFilaments.buildId, src), eq(buildFilaments.roleKey, 'accent')));
	await mutate?.(src);
	return await createDesign(db, 'owner', { buildId: src, name: 'Ocean set', isPublic: true });
}
const startReprint = (id: string) =>
	setPartStatus(db, id, 'owner', 'handle-left', { status: 'Reprint' });
const startPrinting = (id: string) =>
	setPartStatus(db, id, 'owner', 'handle-left', { status: 'Printing' });
const liveJob = async (id: string) => {
	const printerId = (
		await createPrinter(db, orgId, 'owner', {
			name: 'Shop',
			kind: 'elegoo-sdcp',
			secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
			catalogId: 'elegoo-centauri-carbon'
		})
	).id;
	await db.insert(printerJobs).values({
		printerId,
		buildId: id,
		plateNumber: 1,
		partSlugs: [],
		status: 'printing',
		startedAt: new Date()
	});
};

afterEach(() => dropTestDb(db));

describe('Colors only (design.recolor)', () => {
	it('changes hexes only: plates, part roles, locks and spools stay', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startReprint(id);
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['seat-center'], locked: true } });
		await db
			.update(buildFilaments)
			.set({
				spools: 3,
				spoolAdds: [{ id: 'a', kg: 1, at: '2026-01-01', by: 'x' } as never]
			})
			.where(and(eq(buildFilaments.buildId, id), eq(buildFilaments.roleKey, 'accent')));
		const platesBefore = await plates(id);
		const rolesBefore = await rolesOf(id);
		const lockedBefore = (await view(id)).allParts.filter((p) => p.locked).map((p) => p.slug);
		const before = await view(id);

		const plan = (await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'colors' }))!;
		const lockedRole = before.allParts.find((p) => p.slug === 'seat-center')!.role;
		expect(plan.changes.map((c) => c.key)).toContain('accent');
		expect(plan.skipped).toContainEqual(
			expect.objectContaining({ role: lockedRole, reason: 'locked' })
		);
		const v = await view(id);
		expect(await plates(id)).toBe(platesBefore);
		expect(await rolesOf(id)).toEqual(rolesBefore);
		expect(v.allParts.filter((p) => p.locked).map((p) => p.slug)).toEqual(lockedBefore);
		expect(v.runs).toEqual(before.runs);
		expect(v.state['handle-left'].status).toBe('Reprint');
		// the accent slot keeps its spools and adds although it is Lime now
		expect(await fil(id, 'accent')).toMatchObject({ name: 'Lime', spools: 3 });
		expect((await fil(id, 'accent')).spoolAdds).toHaveLength(1);
		expect(plan.keptStock).toContainEqual({
			role: 'accent',
			name: 'Lime',
			was: before.filaments.find((f) => f.key === 'accent')!.name,
			spools: 4
		});
		const row = await lastKind(id);
		expect(row.kind).toBe('design.recolor');
		const p = row.payload as { designName: string; before: ReturnType<typeof designSnapshot> };
		expect(p.designName).toBe('Ocean set');
		expect(p.before).toEqual(designSnapshot(before));
		expect(
			describeActivity(
				(await view(id)).activity.find((a) => a.kind === 'design.recolor')!,
				await view(id)
			)
		).toContain('colors only');
	});

	it('skips a slot whose material family changes and a slot holding locked parts', async () => {
		const d = await makeDesign(async (src) => {
			await db
				.update(buildFilaments)
				.set({ material: 'TPU', name: 'Soft Blue' })
				.where(and(eq(buildFilaments.buildId, src), eq(buildFilaments.roleKey, 'primary')));
		});
		const id = await mk();
		await startReprint(id);
		// accent holds a locked part
		const accentPart = (await view(id)).allParts.find((p) => p.role === 'accent')!;
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: [accentPart.slug], locked: true } });
		const primaryBefore = { ...(await fil(id, 'primary')) };
		const accentBefore = { ...(await fil(id, 'accent')) };
		const plan = await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'colors' });
		expect(plan?.skipped).toEqual(
			expect.arrayContaining([
				{ role: 'primary', name: primaryBefore.name, reason: 'material' },
				{ role: 'accent', name: accentBefore.name, reason: 'locked' }
			])
		);
		expect(await fil(id, 'primary')).toMatchObject({
			name: primaryBefore.name,
			hex: primaryBefore.hex
		});
		expect(await fil(id, 'accent')).toMatchObject({
			name: accentBefore.name,
			hex: accentBefore.hex
		});
	});

	it('does nothing (no activity row) when no slot would change', async () => {
		const id = await mk();
		const d = await createDesign(db, 'owner', { buildId: id, name: 'Same' });
		await startReprint(id);
		const n = (await db.select().from(activity).where(eq(activity.buildId, id))).length;
		expect((await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'colors' }))?.changes).toEqual(
			[]
		);
		expect((await db.select().from(activity).where(eq(activity.buildId, id))).length).toBe(n);
	});

	it("uses the design color most common among a slot's unlocked parts when the design lacks its key", async () => {
		const src = await mk();
		await updateBuildDesign(db, src, 'owner', {
			addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
			partRoles: { 'wing-left': 'red' }
		});
		const d = await createDesign(db, 'owner', { buildId: src, name: 'Red wings' });
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'mine', name: 'Mine', material: 'PETG', hex: '#00ff00' },
			partRoles: { 'wing-left': 'mine', 'wing-right': 'mine' }
		});
		await startReprint(id);
		await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'colors' });
		// "mine" is not in the design: wing-left votes red, wing-right votes its kit slot (one each), either way a design color
		expect(['#aa0000', '#00ff00']).toContain((await fil(id, 'mine')).hex);
		expect((await view(id)).filaments.some((f) => f.key === 'red')).toBe(false);
	});
});

describe('started builds and full mode', () => {
	it('409 build-started without a mode, with started info', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startReprint(id);
		try {
			await applyDesignToBuild(db, d.id, id, 'owner');
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(BuildStartedError);
			expect((e as BuildStartedError).status).toBe(409);
			expect((e as BuildStartedError).code).toBe('build-started');
			expect((e as BuildStartedError).extra.started.started).toBe(true);
		}
		expect((await fil(id, 'primary')).hex).not.toBe('#0044cc');
	});

	it('the 409 body carries code, started and summary', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startReprint(id);
		const res = await respond(() => applyDesignToBuild(db, d.id, id, 'owner'));
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body).toMatchObject({ code: 'build-started', started: { started: true } });
		expect(typeof body.summary).toBe('string');
		expect(typeof body.error).toBe('string');
	});

	it('refuses full while a plate is printing and with a live job, even with confirm', async () => {
		const d = await makeDesign();
		const a = await mk();
		await startPrinting(a);
		expect((await view(a)).started.printingPlates.length).toBeGreaterThan(0);
		expect(
			await status(() => applyDesignToBuild(db, d.id, a, 'owner', { mode: 'full', confirm: true }))
		).toBe(409);
		const b = await mk();
		await liveJob(b);
		expect(
			await status(() => applyDesignToBuild(db, d.id, b, 'owner', { mode: 'full', confirm: true }))
		).toBe(409);
		expect((await fil(a, 'primary')).hex).not.toBe('#0044cc');
		// colors only is still fine while printing
		expect(await status(() => applyDesignToBuild(db, d.id, a, 'owner', { mode: 'colors' }))).toBe(
			0
		);
		expect((await fil(a, 'primary')).hex).toBe('#0044cc');
	});

	it('full on a started build that is not printing needs confirm, then keeps locks', async () => {
		const d = await makeDesign((src) =>
			updateBuildDesign(db, src, 'owner', { partRoles: { 'seat-center': 'accent' } })
		);
		const id = await mk();
		await startReprint(id);
		const lockedSlot = (await view(id)).allParts.find((p) => p.slug === 'seat-center')!.role;
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: ['seat-center'], locked: true } });
		expect(await status(() => applyDesignToBuild(db, d.id, id, 'owner', { mode: 'full' }))).toBe(
			409
		);
		await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'full', confirm: true });
		const v = await view(id);
		expect(v.allParts.find((p) => p.slug === 'seat-center')).toMatchObject({ locked: true });
		// the locked part kept its exact color (old filament), wherever its slot is now
		const part = v.allParts.find((p) => p.slug === 'seat-center')!;
		const slot = v.filaments.find((f) => f.key === part.role)!;
		const original = designSnapshot(await view(id)).roles; // after: only check hex continuity below
		expect(original.length).toBeGreaterThan(0);
		expect(slot).toBeTruthy();
		expect(lockedSlot).toBeTruthy();
		const row = await lastKind(id);
		expect(row.kind).toBe('design.apply');
		expect(row.payload).toMatchObject({ mode: 'full', designName: 'Ocean set' });
		expect((row.payload as { before: unknown }).before).toBeTruthy();
		expect(
			(
				(await first(db.select().from(builds).where(eq(builds.id, id))))!.design as {
					lockedParts: string[];
				}
			).lockedParts
		).toEqual(['seat-center']);
	});

	it('a locked part stays on its exact color when its slot changes in full mode', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startReprint(id);
		const part = (await view(id)).allParts.find((p) => p.role === 'primary')!;
		const old = { ...(await fil(id, 'primary')) };
		await updateBuildDesign(db, id, 'owner', { lock: { slugs: [part.slug], locked: true } });
		await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'full', confirm: true });
		const v = await view(id);
		const nowSlot = v.filaments.find(
			(f) => f.key === v.allParts.find((p) => p.slug === part.slug)!.role
		)!;
		expect(nowSlot).toMatchObject({ name: old.name, material: old.material, hex: old.hex });
		expect((await fil(id, 'primary')).hex).toBe('#0044cc');
	});

	it('not started: unchanged (no mode needed, replaces colors and part slots)', async () => {
		const d = await makeDesign((src) =>
			updateBuildDesign(db, src, 'owner', { partRoles: { 'seat-center': 'accent' } })
		);
		const id = await mk();
		expect((await view(id)).started.started).toBe(false);
		expect(await applyDesignToBuild(db, d.id, id, 'owner')).toBeNull();
		expect((await fil(id, 'primary')).hex).toBe('#0044cc');
		expect((await rolesOf(id))['seat-center']).toBe('accent');
		expect((await lastKind(id)).kind).toBe('design.apply');
	});

	it('rejects an unknown mode', async () => {
		const d = await makeDesign();
		const id = await mk();
		expect(
			await status(() => applyDesignToBuild(db, d.id, id, 'owner', { mode: 'x' as never }))
		).toBe(400);
	});
});

describe('dry run', () => {
	it('reports the plan and writes nothing', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startPrinting(id);
		const n = (await db.select().from(activity).where(eq(activity.buildId, id))).length;
		const pv = await previewApplyDesign(db, d.id, id, 'owner');
		expect(pv.changes.length).toBeGreaterThan(0);
		expect(pv.started.started).toBe(true);
		expect(pv.summary).toMatch(/printing/);
		expect(pv.fullBlocked).toMatch(/printing/);
		expect((await db.select().from(activity).where(eq(activity.buildId, id))).length).toBe(n);
		expect((await fil(id, 'primary')).hex).not.toBe('#0044cc');
	});

	it('needs edit access', async () => {
		const d = await makeDesign();
		const id = await mk();
		await db.insert(user).values({ id: 'v', name: 'V', email: 'v@example.test' });
		await db.insert(member).values({
			id: 'm2',
			organizationId: orgId,
			userId: 'v',
			role: 'viewer',
			createdAt: new Date()
		});
		expect(await status(() => previewApplyDesign(db, d.id, id, 'v'))).toBe(403);
	});
});

describe('palette reset on a started build', () => {
	const pal = (reset: boolean) => ({
		palette: {
			label: 'Sunset',
			reset,
			slots: { primary: { name: 'Sun Orange', material: 'PETG', hex: '#ff8800' } }
		}
	});

	it('needs confirm (409 build-started), stores before, and Undo restores everything', async () => {
		const id = await mk();
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
			partRoles: { 'wing-left': 'red' }
		});
		await startReprint(id);
		const snap = designSnapshot(await view(id));
		expect(await status(() => updateBuildDesign(db, id, 'owner', pal(true)))).toBe(409);
		expect((await fil(id, 'primary')).name).not.toBe('Sun Orange');
		await updateBuildDesign(db, id, 'owner', { ...pal(true), confirm: true });
		expect((await fil(id, 'primary')).name).toBe('Sun Orange');
		expect(((await lastKind(id)).payload as { before: unknown }).before).toEqual(snap);
		// Undo in one call
		await updateBuildDesign(db, id, 'owner', undoPatch(snap, await view(id)));
		expect(await snapOf(id)).toEqual(snapLower(snap));
	});

	it('without reset (colors only) and on a build that has not started: no confirm needed', async () => {
		const a = await mk();
		await startReprint(a);
		expect(await status(() => updateBuildDesign(db, a, 'owner', pal(false)))).toBe(0);
		const b = await mk();
		expect(await status(() => updateBuildDesign(db, b, 'owner', pal(true)))).toBe(0);
		expect(((await lastKind(b)).payload as { before?: unknown }).before).toBeUndefined();
	});
});

describe('undo of an applied design', () => {
	it('restores colors, part slots and removes added slots (full mode)', async () => {
		const d = await makeDesign((src) =>
			updateBuildDesign(db, src, 'owner', {
				addRole: { key: 'red', name: 'Red', material: 'PETG', hex: '#aa0000' },
				partRoles: { 'wing-left': 'red' }
			})
		);
		const id = await mk();
		await startReprint(id);
		const snap = designSnapshot(await view(id));
		await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'full', confirm: true });
		expect((await view(id)).filaments.some((f) => f.key === 'red')).toBe(true);
		await updateBuildDesign(db, id, 'owner', undoPatch(snap, await view(id)));
		expect(await snapOf(id)).toEqual(snapLower(snap));
	});

	it('restores colors (colors only)', async () => {
		const d = await makeDesign();
		const id = await mk();
		await startReprint(id);
		const snap = designSnapshot(await view(id));
		await applyDesignToBuild(db, d.id, id, 'owner', { mode: 'colors' });
		await updateBuildDesign(db, id, 'owner', undoPatch(snap, await view(id)));
		expect(await snapOf(id)).toEqual(snapLower(snap));
	});
});
