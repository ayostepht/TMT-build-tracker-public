import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { describeActivity } from '#lib/domain/activity.ts';
import {
	SAFETY_STEP_KEY,
	checkItemKey,
	filterSteps,
	hwItemKey,
	readyToAssemble,
	resolveItem
} from '#lib/domain/assembly.ts';
import { ASSEMBLY_SECTIONS } from '#lib/domain/assembly.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	builds,
	member,
	organization,
	templateAssemblySteps,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { setAssemblyItem } from './assembly';
import { setVariant, setPartStatus } from './actions';
import { markHandedOff, updateHandoff } from './handoff';
import { createBuild } from './create';
import { onBuildEvents } from './test-helpers';
import { loadBuildView } from './view';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tmt-asm-'));

let db: Db;
let templateId: string;
let buildId: string;

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const u of ['owner', 'editor', 'viewer', 'outsider'])
		await db.insert(user).values({ id: u, name: `User ${u}`, email: `${u}@example.test` });
	for (const [u, role] of [
		['owner', 'owner'],
		['editor', 'editor'],
		['viewer', 'viewer']
	])
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: 'org1', userId: u, role, createdAt: new Date() });
	buildId = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'Chair' },
		'owner'
	);
});

const tmt = templateSeeds[0];

describe('seed assembly steps', () => {
	const steps = tmt.assemblySteps ?? [];
	it('has about 20 steps with unique keys in known sections', () => {
		expect(steps.length).toBeGreaterThanOrEqual(15);
		expect(steps.length).toBeLessThanOrEqual(24);
		expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
		for (const s of steps) {
			expect(s.key).not.toContain(':');
			expect(ASSEMBLY_SECTIONS[s.key.split('.')[0]]).toBeTruthy();
		}
		expect(steps.at(-1)!.key).toBe(SAFETY_STEP_KEY);
	});

	it('references existing parts, hardware, guide pages and variant options', () => {
		const slugs = new Set(tmt.parts.map((p) => p.slug));
		const hw = new Set(tmt.hardware.map((h) => h.name));
		const pages = new Set(tmt.guidePages.map((g) => g.page));
		for (const s of steps) {
			for (const p of s.parts ?? []) expect(slugs.has(p), `${s.key}: part ${p}`).toBe(true);
			for (const h of s.hardware ?? [])
				expect(hw.has(h.name), `${s.key}: hardware ${h.name}`).toBe(true);
			if (s.guidePage !== undefined) expect(pages.has(s.guidePage), `${s.key}: page`).toBe(true);
			const keys = (s.checks ?? []).map((c) => c.key);
			expect(new Set(keys).size).toBe(keys.length);
			if (s.when) {
				const g = tmt.variantGroups!.find((x) => x.key === s.when!.group);
				expect(
					g?.options.some((o) => o.key === s.when!.option),
					`${s.key}: when`
				).toBe(true);
			}
		}
	});

	it('is stored on the template and reconciling again changes nothing', async () => {
		const n = await db
			.select()
			.from(templateAssemblySteps)
			.where(eq(templateAssemblySteps.templateId, templateId));
		expect(n).toHaveLength(steps.length);
		expect((await seedTemplates(db, templateSeeds)).updated).toEqual([]);
	});
});

describe('variant filtering', () => {
	const keys = async () =>
		(await loadBuildView(db, buildId, 'owner'))!.assembly.steps.map((s) => s.key);

	it('shows the default variants', async () => {
		const k = await keys();
		expect(k).toContain('frame.footrest-one');
		expect(k).not.toContain('frame.footrest-two');
		expect(k).toContain('seat.cushions');
		expect(k).not.toContain('seat.bucket');
		expect(k).toContain('extras.headrest');
		expect(k).toContain('extras.push-handle');
	});

	it('follows the chosen options and filters step parts to active ones', async () => {
		await setVariant(db, buildId, 'owner', { group: 'footrest', option: 'two-piece' });
		await setVariant(db, buildId, 'owner', { group: 'seat', option: 'bucket-seat' });
		await setVariant(db, buildId, 'owner', { group: 'headrest', option: 'none' });
		await setVariant(db, buildId, 'owner', { group: 'rear-caster', option: 'mcmaster' });
		const v = (await loadBuildView(db, buildId, 'owner'))!;
		const k = v.assembly.steps.map((s) => s.key);
		expect(k).toContain('frame.footrest-two');
		expect(k).not.toContain('frame.footrest-one');
		expect(k).toContain('seat.bucket');
		expect(k).not.toContain('seat.cushions');
		expect(k).not.toContain('extras.headrest');
		const rear = v.assembly.steps.find((s) => s.key === 'frame.rear-casters')!;
		expect(rear.parts).toContain('rear-caster-left-mcmaster');
		expect(rear.parts).not.toContain('rear-caster-left');
		const wheels = v.assembly.steps.find((s) => s.key === 'wheels.tires')!;
		expect(wheels.parts).toContain('rims-1-4');
		expect(wheels.parts).not.toContain('rims-small-1-4');
	});

	it('filterSteps drops a step whose parts are all inactive', () => {
		const rows = [
			{
				key: 'extras.x',
				title: 'x',
				description: '',
				guidePage: null,
				parts: ['a'],
				hardware: [],
				checks: [],
				when: null
			}
		];
		expect(filterSteps(rows, {}, new Set())).toEqual([]);
		expect(filterSteps(rows, {}, new Set(['a']))).toHaveLength(1);
	});
});

describe('setAssemblyItem', () => {
	const view = async () => (await loadBuildView(db, buildId, 'owner'))!;

	it('ticks a step, a check and a hardware item, with who and when', async () => {
		const step = (await view()).assembly.steps.find((s) => s.key === 'frame.rear-casters')!;
		const events = onBuildEvents(buildId);
		await setAssemblyItem(db, buildId, 'editor', step.key, { done: true });
		await setAssemblyItem(db, buildId, 'editor', checkItemKey(step.key, step.checks[0].key), {
			done: true
		});
		await setAssemblyItem(db, buildId, 'owner', hwItemKey(step.key, 'Casters'), { done: true });
		const v = await view();
		expect(v.assembly.items[step.key]).toMatchObject({
			done: true,
			doneBy: 'editor',
			doneByName: 'User editor'
		});
		expect(v.assembly.items[step.key].doneAt).toBeTruthy();
		expect(v.assembly.items[checkItemKey(step.key, step.checks[0].key)].done).toBe(true);
		expect(v.assembly.items[hwItemKey(step.key, 'Casters')].doneBy).toBe('owner');
		expect(events.map((e) => e.type)).toEqual(['changed', 'changed', 'changed']);
		const rows = (await db.select().from(activity).where(eq(activity.buildId, buildId))).filter(
			(a) => a.kind === 'assembly.item'
		);
		expect(rows).toHaveLength(3);
		const names = { parts: v.parts, filaments: v.filaments, members: v.members, runs: v.runs };
		const sentence = describeActivity(
			{
				id: 'x',
				userId: 'editor',
				userName: 'Eddie',
				kind: 'assembly.item',
				payload: rows[0].payload,
				at: ''
			},
			names
		);
		expect(sentence).toBe('Eddie marked step "Rear caster mounts" done');
		expect(
			describeActivity(
				{
					id: 'y',
					userId: null,
					userName: 'Eddie',
					kind: 'assembly.item',
					payload: rows[1].payload,
					at: ''
				},
				names
			)
		).toContain('ticked');
	});

	it('unticking clears who and when; a note alone keeps the tick', async () => {
		await setAssemblyItem(db, buildId, 'editor', 'frame.handle', { done: true, note: 'tight fit' });
		await setAssemblyItem(db, buildId, 'editor', 'frame.handle', { note: 'tight fit, sanded' });
		expect((await view()).assembly.items['frame.handle']).toMatchObject({
			done: true,
			note: 'tight fit, sanded'
		});
		await setAssemblyItem(db, buildId, 'owner', 'frame.handle', { done: false });
		const it = (await view()).assembly.items['frame.handle'];
		expect(it).toMatchObject({
			done: false,
			doneBy: null,
			doneAt: null,
			note: 'tight fit, sanded'
		});
	});

	it('rejects viewers (403), outsiders (404) and unknown or inactive items (400)', async () => {
		const code = async (fn: () => void) => {
			try {
				await fn();
			} catch (e) {
				return (e as ApiError).status;
			}
			return 0;
		};
		expect(
			await code(
				async () => await setAssemblyItem(db, buildId, 'viewer', 'frame.handle', { done: true })
			)
		).toBe(403);
		expect(
			await code(
				async () => await setAssemblyItem(db, buildId, 'outsider', 'frame.handle', { done: true })
			)
		).toBe(404);
		expect(
			await code(async () => await setAssemblyItem(db, buildId, 'owner', 'nope', { done: true }))
		).toBe(400);
		expect(
			await code(
				async () =>
					await setAssemblyItem(db, buildId, 'owner', 'frame.handle:check:nope', { done: true })
			)
		).toBe(400);
		expect(
			await code(
				async () =>
					await setAssemblyItem(db, buildId, 'owner', 'frame.footrest-two', { done: true })
			)
		).toBe(400);
		expect(
			await code(async () => await setAssemblyItem(db, buildId, 'owner', 'frame.handle', {}))
		).toBe(400);
		expect(
			await code(
				async () => await setAssemblyItem(db, buildId, 'owner', 'frame.handle', { done: 'yes' })
			)
		).toBe(400);
		expect((await view()).assembly.items).toEqual({});
	});
});

describe('resolveItem and readiness', () => {
	it('resolves step, check and hardware keys', async () => {
		const steps = (await loadBuildView(db, buildId, 'owner'))!.assembly.steps;
		expect(resolveItem(steps, 'frame.handle')?.kind).toBe('step');
		expect(resolveItem(steps, 'frame.handle:check:flat')?.kind).toBe('check');
		expect(resolveItem(steps, 'frame.rear-casters:hw:Casters')?.kind).toBe('hw');
		expect(resolveItem(steps, 'frame.rear-casters:hw:Nope')).toBeNull();
		expect(resolveItem(steps, 'frame.handle:bogus:flat')).toBeNull();
	});

	it('is ready only when every active part is printed', async () => {
		let v = (await loadBuildView(db, buildId, 'owner'))!;
		expect(readyToAssemble(v).ready).toBe(false);
		for (const p of v.parts)
			await setPartStatus(db, buildId, 'owner', p.slug, { status: 'Printed' });
		v = (await loadBuildView(db, buildId, 'owner'))!;
		expect(readyToAssemble(v)).toMatchObject({ ready: true, missing: [] });
	});
});

describe('handoff', () => {
	it('saves the form (editors only) and marks the build done', async () => {
		await expect(updateHandoff(db, buildId, 'viewer', { notes: 'x' })).rejects.toThrow(ApiError);
		await updateHandoff(db, buildId, 'editor', {
			recipientName: 'Sam',
			organization: 'City Clinic',
			contact: 'sam@example.test',
			safetyChecked: true
		});
		let v = (await loadBuildView(db, buildId, 'owner'))!;
		expect(v.handoff).toMatchObject({
			recipientName: 'Sam',
			contact: 'sam@example.test',
			safetyChecked: true
		});
		expect(v.build.phase).not.toBe('done');
		await markHandedOff(db, buildId, 'editor', { handedOffOn: '2026-11-03' });
		v = (await loadBuildView(db, buildId, 'owner'))!;
		expect(v.build.phase).toBe('done');
		expect(v.handoff?.handedOffOn).toBe('2026-11-03');
		expect(v.handoff?.organization).toBe('City Clinic');
		const kinds = (await db.select().from(activity).where(eq(activity.buildId, buildId))).map(
			(a) => a.kind
		);
		expect(kinds).toContain('build.handoff');
		const a = (await first(db.select().from(activity).where(eq(activity.kind, 'build.handoff'))))!;
		expect(
			describeActivity(
				{ id: 'z', userId: 'editor', userName: 'Eddie', kind: a.kind, payload: a.payload, at: '' },
				v
			)
		).toBe('Eddie marked the chair as handed off to City Clinic');
		expect(
			(await first(db.select({ p: builds.phase }).from(builds).where(eq(builds.id, buildId))))!.p
		).toBe('done');
	});

	it('hides the recipient contact from viewers everywhere it is serialized', async () => {
		await updateHandoff(db, buildId, 'editor', {
			recipientName: 'Sam',
			contact: 'secret-contact-123'
		});
		for (const who of ['owner', 'editor'])
			expect((await loadBuildView(db, buildId, who))!.handoff?.contact).toBe('secret-contact-123');
		const v = (await loadBuildView(db, buildId, 'viewer'))!;
		expect(v.handoff).toMatchObject({ recipientName: 'Sam', contact: null });
		expect(JSON.stringify(v)).not.toContain('secret-contact-123');
		await markHandedOff(db, buildId, 'editor', { contact: 'secret-contact-123' });
		const acts = await db.select().from(activity).where(eq(activity.buildId, buildId));
		expect(JSON.stringify(acts)).not.toContain('secret-contact-123');
		expect(JSON.stringify(await loadBuildView(db, buildId, 'viewer'))).not.toContain(
			'secret-contact-123'
		);
	});

	it('rejects bad input and defaults the date to today', async () => {
		await expect(
			updateHandoff(db, buildId, 'owner', { handedOffOn: '03/11/2026' })
		).rejects.toThrow(ApiError);
		await expect(updateHandoff(db, buildId, 'owner', {})).rejects.toThrow(ApiError);
		await expect(markHandedOff(db, buildId, 'outsider', {})).rejects.toThrow(ApiError);
		await markHandedOff(db, buildId, 'owner', {});
		expect((await loadBuildView(db, buildId, 'owner'))!.handoff?.handedOffOn).toMatch(
			/^\d{4}-\d{2}-\d{2}$/
		);
	});
});
