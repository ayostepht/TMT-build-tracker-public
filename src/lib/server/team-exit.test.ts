import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAuth } from './auth';
import { enableTestSignIn, signInTestUser } from './auth-test-helpers';
import { createBuild } from './builds/create';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import {
	buildParts,
	buildPhotos,
	builds,
	invitation,
	member,
	organization,
	printers,
	session,
	templates
} from './db/schema';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { deleteAccount } from './account';
import { findPersonalWorkspace } from './teams';
import {
	changeMemberRole,
	deleteTeam,
	leaveTeam,
	removeTeamMember,
	teamDeletionSummary
} from './team-exit';

let db: Db;
let dir: string;
let templateId: string;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'tmt-team-exit-'));
	vi.stubEnv('DATA_DIR', dir);
	vi.stubEnv('BETTER_AUTH_SECRET', 'a'.repeat(40));
	for (const k of ['TMT_MODE', 'PUBLIC_URL']) vi.stubEnv(k, '');
	vi.stubEnv('ADMIN_EMAILS', 'admin@example.test');
	enableTestSignIn();
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

async function signUp(name: string) {
	const auth = createAuth(db);
	const u = await signInTestUser(auth, name, `${name.toLowerCase()}@example.test`);
	return u.id;
}

async function addTeam(id: string, members: [string, string][]) {
	await db.insert(organization).values({ id, name: `Team ${id}`, slug: id, createdAt: new Date() });
	for (const [i, [userId, role]] of members.entries())
		await db.insert(member).values({
			id: `m-${id}-${userId}`,
			organizationId: id,
			userId,
			role,
			createdAt: new Date(1000 + i)
		});
}

const addBuild = (orgId: string, userId: string, kind: 'build' | 'draft' = 'build') =>
	createBuild(db, { organizationId: orgId, templateId, designId: null, name: 'B', kind }, userId);

function writeUpload(rel: string) {
	const p = join(dir, 'uploads', rel);
	mkdirSync(join(p, '..'), { recursive: true });
	writeFileSync(p, 'x');
	return p;
}
const roleOf = async (orgId: string, userId: string) =>
	(
		await first(
			db
				.select({ r: member.role })
				.from(member)
				.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		)
	)?.r;
const ownerCount = async (orgId: string) =>
	(
		await db
			.select()
			.from(member)
			.where(and(eq(member.organizationId, orgId), eq(member.role, 'owner')))
	).length;

describe('leaveTeam', () => {
	it('an editor leaves; the team, its builds and the others stay; their builds move to an owner', async () => {
		const [own, ed, vw] = [await signUp('Own'), await signUp('Ed'), await signUp('Vw')];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor'],
			[vw, 'viewer']
		]);
		const b = await addBuild('t1', ed);
		const draft = await addBuild('t1', ed, 'draft');
		const photo = writeUpload(`photos/${draft}/p.webp`);
		await db
			.insert(buildPhotos)
			.values({ buildId: draft, kind: 'progress', path: `photos/${draft}/p.webp`, createdBy: ed });
		await db.insert(printers).values({
			organizationId: 't1',
			name: 'P',
			kind: 'manual',
			host: 'x',
			createdBy: ed
		});
		await db.update(buildParts).set({ assigneeUserId: ed }).where(eq(buildParts.buildId, b));
		expect(
			(await db.select().from(buildParts).where(eq(buildParts.assigneeUserId, ed))).length
		).toBeGreaterThan(0);
		const edSession = (await db.select().from(session).where(eq(session.userId, ed)))[0];
		await db
			.update(session)
			.set({ activeOrganizationId: 't1' })
			.where(eq(session.id, edSession.id));

		await leaveTeam(db, ed, 't1');

		expect(await roleOf('t1', ed)).toBeUndefined();
		expect(await db.select().from(member).where(eq(member.organizationId, 't1'))).toHaveLength(2);
		expect((await first(db.select().from(builds).where(eq(builds.id, b))))!.createdBy).toBe(own);
		expect(await first(db.select().from(builds).where(eq(builds.id, draft)))).toBeUndefined();
		expect(existsSync(photo)).toBe(false);
		expect((await first(db.select().from(printers)))!.createdBy).toBe(own);
		expect(
			(await db.select().from(buildParts).where(eq(buildParts.assigneeUserId, ed))).length
		).toBe(0);
		expect(
			(await first(db.select().from(session).where(eq(session.id, edSession.id))))!
				.activeOrganizationId
		).toBeNull();
		// their account and personal workspace are untouched
		expect(await findPersonalWorkspace(db, ed)).toBeTruthy();
	});

	it('one of two owners leaves without naming anyone', async () => {
		const [a, b] = [await signUp('Aa'), await signUp('Bb')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner']
		]);
		const made = await addBuild('t1', a);
		await leaveTeam(db, a, 't1');
		expect(await roleOf('t1', b)).toBe('owner');
		expect((await first(db.select().from(builds).where(eq(builds.id, made))))!.createdBy).toBe(b);
	});

	it('the sole owner with others must name an heir, who becomes owner', async () => {
		const [a, b, c] = [await signUp('Aa'), await signUp('Bb'), await signUp('Cc')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'viewer'],
			[c, 'editor']
		]);
		const made = await addBuild('t1', a);
		await expect(leaveTeam(db, a, 't1')).rejects.toMatchObject({ status: 409, code: 'needs_heir' });
		await expect(leaveTeam(db, a, 't1', 'nobody')).rejects.toMatchObject({ code: 'needs_heir' });
		await expect(leaveTeam(db, a, 't1', a)).rejects.toMatchObject({ code: 'needs_heir' });
		expect(await roleOf('t1', a)).toBe('owner');
		expect(await roleOf('t1', c)).toBe('editor');
		await leaveTeam(db, a, 't1', c);
		expect(await roleOf('t1', a)).toBeUndefined();
		expect(await roleOf('t1', c)).toBe('owner');
		expect(await roleOf('t1', b)).toBe('viewer');
		expect((await first(db.select().from(builds).where(eq(builds.id, made))))!.createdBy).toBe(c);
	});

	it('the only member cannot leave', async () => {
		const a = await signUp('Aa');
		await addTeam('t1', [[a, 'owner']]);
		await expect(leaveTeam(db, a, 't1')).rejects.toMatchObject({
			status: 409,
			code: 'only_member',
			message: "You're the only one here. Delete the team instead."
		});
		expect(await roleOf('t1', a)).toBe('owner');
	});

	it('refuses a non-member (404) and a personal workspace', async () => {
		const [a, z] = [await signUp('Aa'), await signUp('Zz')];
		await addTeam('t1', [[a, 'owner']]);
		await expect(leaveTeam(db, z, 't1')).rejects.toMatchObject({ status: 404 });
		const personal = (await findPersonalWorkspace(db, a))!;
		await expect(leaveTeam(db, a, personal.id)).rejects.toMatchObject({ code: 'personal' });
	});

	it('two owners leaving at once cannot leave the team without an owner', async () => {
		const [a, b] = [await signUp('Aa'), await signUp('Bb')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner']
		]);
		const res = await Promise.allSettled([leaveTeam(db, a, 't1'), leaveTeam(db, b, 't1')]);
		expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(await ownerCount('t1')).toBe(1);
		expect(await db.select().from(member).where(eq(member.organizationId, 't1'))).toHaveLength(1);
	});
});

describe('deleteTeam', () => {
	it('an owner deletes the team and everything in it; other accounts and teams stay', async () => {
		const [own, ed] = [await signUp('Own'), await signUp('Ed')];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor']
		]);
		await addTeam('t2', [
			[own, 'owner'],
			[ed, 'editor']
		]);
		const b = await addBuild('t1', ed);
		const keep = await addBuild('t2', ed);
		const photo = writeUpload(`photos/${b}/p.webp`);
		await db
			.insert(buildPhotos)
			.values({ buildId: b, kind: 'progress', path: `photos/${b}/p.webp`, createdBy: ed });
		const keepFile = writeUpload(`photos/${keep}/p.webp`);
		await db
			.insert(printers)
			.values({ organizationId: 't1', name: 'P', kind: 'manual', host: 'x', secretEnc: 'enc' });
		await db.insert(invitation).values({
			id: 'i1',
			organizationId: 't1',
			email: 'x@example.test',
			status: 'pending',
			expiresAt: new Date(Date.now() + 1e6),
			inviterId: own
		});
		const edSession = (await db.select().from(session).where(eq(session.userId, ed)))[0];
		await db
			.update(session)
			.set({ activeOrganizationId: 't1' })
			.where(eq(session.id, edSession.id));
		const copy = `c-t1`;
		await db.insert(templates).values({
			id: copy,
			slug: copy,
			name: 'Copy',
			version: '1',
			ownerOrgId: 't1',
			baseTemplateId: templateId
		} as never);

		expect(await teamDeletionSummary(db, 't1', own)).toEqual({
			builds: 1,
			otherMembers: 1,
			printers: 1,
			pendingInvitations: 1
		});
		await deleteTeam(db, own, 't1', ' Team t1 ');

		expect(
			await first(db.select().from(organization).where(eq(organization.id, 't1')))
		).toBeUndefined();
		expect(await first(db.select().from(builds).where(eq(builds.id, b)))).toBeUndefined();
		expect(await db.select().from(printers)).toHaveLength(0);
		expect(await db.select().from(invitation)).toHaveLength(0);
		expect(await db.select().from(member).where(eq(member.organizationId, 't1'))).toHaveLength(0);
		expect(await first(db.select().from(templates).where(eq(templates.id, copy)))).toBeUndefined();
		expect(existsSync(photo)).toBe(false);
		expect(
			(await first(db.select().from(session).where(eq(session.id, edSession.id))))!
				.activeOrganizationId
		).toBeNull();
		// the other team, the build and file there, and everyone's accounts stay
		expect(await roleOf('t2', ed)).toBe('editor');
		expect(await first(db.select().from(builds).where(eq(builds.id, keep)))).toBeTruthy();
		expect(existsSync(keepFile)).toBe(true);
		expect(await findPersonalWorkspace(db, ed)).toBeTruthy();
		expect(await findPersonalWorkspace(db, own)).toBeTruthy();
	});

	it('refuses an editor and a viewer, a wrong name, a non-member and a personal workspace', async () => {
		const [own, ed, vw, z] = [
			await signUp('Own'),
			await signUp('Ed'),
			await signUp('Vw'),
			await signUp('Zz')
		];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor'],
			[vw, 'viewer']
		]);
		await expect(deleteTeam(db, ed, 't1', 'Team t1')).rejects.toMatchObject({ status: 403 });
		await expect(deleteTeam(db, vw, 't1', 'Team t1')).rejects.toMatchObject({ status: 403 });
		await expect(deleteTeam(db, z, 't1', 'Team t1')).rejects.toMatchObject({ status: 404 });
		await expect(deleteTeam(db, own, 't1', 'team t1')).rejects.toMatchObject({
			status: 400,
			code: 'wrong_name'
		});
		await expect(deleteTeam(db, own, 't1', '')).rejects.toMatchObject({ code: 'wrong_name' });
		const personal = (await findPersonalWorkspace(db, own))!;
		await expect(deleteTeam(db, own, personal.id, personal.name)).rejects.toMatchObject({
			code: 'personal'
		});
		expect(
			await first(db.select().from(organization).where(eq(organization.id, 't1')))
		).toBeTruthy();
	});

	it('the only member can delete a team they are alone in', async () => {
		const a = await signUp('Aa');
		await addTeam('t1', [[a, 'owner']]);
		await deleteTeam(db, a, 't1', 'Team t1');
		expect(
			await first(db.select().from(organization).where(eq(organization.id, 't1')))
		).toBeUndefined();
	});
});

const memberId = (orgId: string, userId: string) => `m-${orgId}-${userId}`;

describe('removeTeamMember', () => {
	it('an owner removes a member and what they made is handed over', async () => {
		const [own, ed] = [await signUp('Own'), await signUp('Ed')];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor']
		]);
		const b = await addBuild('t1', ed);
		const draft = await addBuild('t1', ed, 'draft');
		await db
			.insert(printers)
			.values({ organizationId: 't1', name: 'P', kind: 'manual', host: 'x', createdBy: ed });
		const s = (await db.select().from(session).where(eq(session.userId, ed)))[0];
		await db.update(session).set({ activeOrganizationId: 't1' }).where(eq(session.id, s.id));

		await removeTeamMember(db, own, 't1', memberId('t1', ed));

		expect(await roleOf('t1', ed)).toBeUndefined();
		expect((await first(db.select().from(builds).where(eq(builds.id, b))))!.createdBy).toBe(own);
		expect(await first(db.select().from(builds).where(eq(builds.id, draft)))).toBeUndefined();
		expect((await first(db.select().from(printers)))!.createdBy).toBe(own);
		expect(
			(await first(db.select().from(session).where(eq(session.id, s.id))))!.activeOrganizationId
		).toBeNull();
		expect(await findPersonalWorkspace(db, ed)).toBeTruthy();
	});

	it('refuses your own row, a non-owner and an unknown member', async () => {
		const [own, ed] = [await signUp('Own'), await signUp('Ed')];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor']
		]);
		await expect(removeTeamMember(db, own, 't1', memberId('t1', own))).rejects.toMatchObject({
			status: 400,
			message: 'To remove yourself, use "Leave this team" below.'
		});
		await expect(removeTeamMember(db, ed, 't1', memberId('t1', own))).rejects.toMatchObject({
			status: 403
		});
		await expect(removeTeamMember(db, own, 't1', 'nope')).rejects.toMatchObject({ status: 404 });
		expect(await db.select().from(member).where(eq(member.organizationId, 't1'))).toHaveLength(2);
	});
});

describe('changeMemberRole', () => {
	it('changes roles, but the last owner cannot be demoted and only owners may', async () => {
		const [own, ed] = [await signUp('Own'), await signUp('Ed')];
		await addTeam('t1', [
			[own, 'owner'],
			[ed, 'editor']
		]);
		await expect(
			changeMemberRole(db, own, 't1', memberId('t1', own), 'editor')
		).rejects.toMatchObject({ status: 409, code: 'last_owner' });
		await expect(changeMemberRole(db, ed, 't1', memberId('t1', ed), 'owner')).rejects.toMatchObject(
			{
				status: 403
			}
		);
		await expect(
			changeMemberRole(db, own, 't1', memberId('t1', ed), 'admin')
		).rejects.toMatchObject({
			status: 400
		});
		await changeMemberRole(db, own, 't1', memberId('t1', ed), 'owner');
		expect(await roleOf('t1', ed)).toBe('owner');
		await changeMemberRole(db, own, 't1', memberId('t1', own), 'viewer');
		expect(await roleOf('t1', own)).toBe('viewer');
		expect(await ownerCount('t1')).toBe(1);
	});

	it('a co-owner demoting themselves while the other owner leaves keeps an owner', async () => {
		const [a, b] = [await signUp('Aa'), await signUp('Bb')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner']
		]);
		await Promise.allSettled([
			changeMemberRole(db, a, 't1', memberId('t1', a), 'editor'),
			leaveTeam(db, b, 't1')
		]);
		expect(await ownerCount('t1')).toBeGreaterThanOrEqual(1);
	});

	it('the heir leaving while the sole owner hands over to them keeps an owner', async () => {
		const [a, c] = [await signUp('Aa'), await signUp('Cc')];
		await addTeam('t1', [
			[a, 'owner'],
			[c, 'editor']
		]);
		const res = await Promise.allSettled([leaveTeam(db, c, 't1'), leaveTeam(db, a, 't1', c)]);
		expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(await ownerCount('t1')).toBe(1);
	});
});

describe('account deletion and the team lock', () => {
	/** No team may have members and no owner. */
	async function ownerless() {
		const orgs = await db.select({ id: organization.id }).from(organization);
		const bad: string[] = [];
		for (const o of orgs) {
			const ms = await db.select().from(member).where(eq(member.organizationId, o.id));
			if (ms.length && !ms.some((m) => m.role === 'owner')) bad.push(o.id);
		}
		return bad;
	}

	it('an owner deleting their account while the other owner leaves keeps an owner', async () => {
		await signUp('Admin');
		const [a, b, c] = [await signUp('Aa'), await signUp('Bb'), await signUp('Cc')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner'],
			[c, 'viewer']
		]);
		const made = await addBuild('t1', a);
		await Promise.allSettled([deleteAccount(db, a), leaveTeam(db, b, 't1')]);
		expect(await ownerless()).toEqual([]);
		// the build's creator, if the build is still there, is still a member
		const row = await first(db.select().from(builds).where(eq(builds.id, made)));
		if (row) expect(await roleOf('t1', row.createdBy)).toBeDefined();
	});

	it('two owners deleting their accounts at once leave no ownerless team with members', async () => {
		await signUp('Admin');
		const [a, b, c] = [await signUp('Aa'), await signUp('Bb'), await signUp('Cc')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner'],
			[c, 'viewer']
		]);
		const res = await Promise.allSettled([deleteAccount(db, a), deleteAccount(db, b)]);
		expect(await ownerless()).toEqual([]);
		// either both went through (the viewer was left behind as the only member, or the team went)
		// or the second was refused because it had become the sole owner of a team with members
		for (const r of res)
			if (r.status === 'rejected') expect(String(r.reason.message)).toContain('Make someone else');
		expect(res.some((r) => r.status === 'fulfilled')).toBe(true);
	});

	it('an owner deleting their account while being demoted ends consistent', async () => {
		await signUp('Admin');
		const [a, b] = [await signUp('Aa'), await signUp('Bb')];
		await addTeam('t1', [
			[a, 'owner'],
			[b, 'owner']
		]);
		await Promise.allSettled([
			deleteAccount(db, a),
			changeMemberRole(db, b, 't1', memberId('t1', b), 'viewer')
		]);
		expect(await ownerless()).toEqual([]);
	});
});
