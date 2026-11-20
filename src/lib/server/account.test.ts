import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAuth, ORGANIZATION_DISABLED_PATHS, type Auth } from './auth';
import { ApiError } from './access';
import { decideNewUser } from './auth-policy';
import { enableTestSignIn, signInTestUser } from './auth-test-helpers';
import { deleteAccount, exportAccountData, planAccountDeletion } from './account';
import { createBuild } from './builds/create';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import {
	account,
	activity,
	buildPhotos,
	builds,
	colorDesigns,
	invitation,
	member,
	organization,
	session,
	templates,
	user,
	verification
} from './db/schema';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { findPersonalWorkspace } from './teams';

let db: Db;
let auth: Auth;
let dir: string;
let templateId: string;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'tmt-account-'));
	vi.stubEnv('DATA_DIR', dir);
	vi.stubEnv('BETTER_AUTH_SECRET', 'a'.repeat(40));
	for (const k of ['TMT_MODE', 'PUBLIC_URL']) vi.stubEnv(k, '');
	// The site admin of these tests (a verified address in ADMIN_EMAILS).
	vi.stubEnv('ADMIN_EMAILS', 'admin@example.test');
	enableTestSignIn();
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	auth = createAuth(db);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

async function signUp(name: string, email: string) {
	const u = await signInTestUser(auth, name, email);
	return { id: u.id, cookie: u.headers.get('cookie')! };
}

/** A real request through Better Auth's handler, as the browser would send it. */
function post(path: string, cookie: string, body: unknown) {
	return auth.handler(
		new Request(`http://localhost/api/auth${path}`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost' },
			body: JSON.stringify(body)
		})
	);
}

describe('organization quotas through the plugin endpoints', () => {
	it('chaptersPerUser refuses the second chapter with a sentence; personal does not count', async () => {
		await signUp('Admin', 'admin@example.test'); // a site admin is exempt
		const u = await signUp('Pat', 'pat@example.test');
		vi.stubEnv('QUOTA_CHAPTERS_PER_USER', '1');
		const a = await post('/organization/create', u.cookie, { name: 'One', slug: 'one' });
		expect(a.status).toBe(200);
		const b = await post('/organization/create', u.cookie, { name: 'Two', slug: 'two' });
		expect(b.status).toBe(409);
		const body = (await b.json()) as { message: string; code: string };
		expect(body.message).toContain('You already created 1 team');
		expect(body.code).toBe('QUOTA');
		expect(
			await first(db.select().from(organization).where(eq(organization.slug, 'two')))
		).toBeUndefined();
	});

	it('exempts site admins', async () => {
		const admin = await signUp('Admin', 'admin@example.test');
		vi.stubEnv('QUOTA_CHAPTERS_PER_USER', '0');
		const r = await post('/organization/create', admin.cookie, { name: 'A', slug: 'a' });
		expect(r.status).toBe(200);
	});

	it('membershipsPerUser blocks creating and joining', async () => {
		await signUp('Admin', 'admin@example.test');
		const owner = await signUp('Owner', 'owner@example.test');
		const guest = await signUp('Guest', 'guest@example.test');
		await post('/organization/create', owner.cookie, { name: 'C1', slug: 'c1' });
		await post('/organization/create', guest.cookie, { name: 'G1', slug: 'g1' });
		const org = (await first(db.select().from(organization).where(eq(organization.slug, 'c1'))))!;
		const inv = await post('/organization/invite-member', owner.cookie, {
			email: 'guest@example.test',
			role: 'viewer',
			organizationId: org.id
		});
		expect(inv.status).toBe(200);
		const { id } = (await inv.json()) as { id: string };
		vi.stubEnv('QUOTA_MEMBERSHIPS_PER_USER', '1');
		const acc = await post('/organization/accept-invitation', guest.cookie, { invitationId: id });
		expect(acc.status).toBeGreaterThanOrEqual(400);
		expect(((await acc.json()) as { message: string }).message).toContain(
			'already belong to 1 team'
		);
		expect(await db.select().from(member).where(eq(member.organizationId, org.id))).toHaveLength(1);
		const c2 = await post('/organization/create', guest.cookie, { name: 'G2', slug: 'g2' });
		expect(c2.status).toBe(409);
	});

	it('membersPerChapter and pendingInvitesPerChapter', async () => {
		await signUp('Admin', 'admin@example.test');
		const owner = await signUp('Owner', 'owner@example.test');
		const guest = await signUp('Guest', 'guest@example.test');
		await post('/organization/create', owner.cookie, { name: 'C1', slug: 'c1' });
		const org = (await first(db.select().from(organization).where(eq(organization.slug, 'c1'))))!;
		vi.stubEnv('QUOTA_PENDING_INVITES_PER_CHAPTER', '1');
		const invite = (email: string) =>
			post('/organization/invite-member', owner.cookie, {
				email,
				role: 'viewer',
				organizationId: org.id
			});
		const firstInv = await invite('guest@example.test');
		expect(firstInv.status).toBe(200);
		const second = await invite('other@example.test');
		expect(second.status).toBe(409);
		expect(((await second.json()) as { message: string }).message).toContain('open invitation');
		vi.stubEnv('QUOTA_MEMBERS_PER_CHAPTER', '1');
		const { id } = (await firstInv.json()) as { id: string };
		const acc = await post('/organization/accept-invitation', guest.cookie, { invitationId: id });
		expect(acc.status).toBeGreaterThanOrEqual(400);
		expect(((await acc.json()) as { message: string }).message).toContain('already has 1 member');
	});

	it('disables organization/update (it could clear the personal flag)', async () => {
		await signUp('Admin', 'admin@example.test');
		const u = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, u.id))!;
		for (const path of ORGANIZATION_DISABLED_PATHS) {
			const r = await post(path, u.cookie, {
				organizationId: personal.id,
				data: { metadata: {} },
				slug: 'x'
			});
			expect(r.status, path).toBe(404);
		}
	});
});

describe('account caps', () => {
	const verified = (email: string) => ({ email, emailVerified: true });

	it('refuses new accounts at accountsTotal but lets admins in', async () => {
		await signUp('First', 'first@example.test');
		vi.stubEnv('QUOTA_ACCOUNTS_TOTAL', '1');
		const d = await decideNewUser(db, verified('new@example.test'));
		expect(d).toMatchObject({ ok: false, code: 'signups_paused' });
		expect(d.ok ? '' : d.message).toBe('This server is not taking new accounts right now.');
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		expect((await decideNewUser(db, verified('boss@example.test'))).ok).toBe(true);
	});

	it('demo users are not accounts: they neither count nor are refused by the caps', async () => {
		vi.stubEnv('QUOTA_ACCOUNTS_TOTAL', '1');
		await signUp('First', 'first@example.test');
		await db.insert(user).values({ id: 'demo1', name: 'D', email: 'd@demo.invalid', isDemo: true });
		expect((await decideNewUser(db, { isDemo: true })).ok).toBe(true);
		// the demo row does not use up the cap for real people either
		vi.stubEnv('QUOTA_ACCOUNTS_TOTAL', '2');
		expect((await decideNewUser(db, verified('new@example.test'))).ok).toBe(true);
	});

	it('signupsPerDay counts only the last 24 hours', async () => {
		await signUp('First', 'first@example.test');
		vi.stubEnv('QUOTA_SIGNUPS_PER_DAY', '1');
		expect((await decideNewUser(db, verified('n@example.test'))).ok).toBe(false);
		expect(
			(await decideNewUser(db, verified('n@example.test'), new Date(Date.now() + 25 * 3600 * 1000)))
				.ok
		).toBe(true);
	});

	it('requires a verified email, caps apply after', async () => {
		vi.stubEnv('QUOTA_ACCOUNTS_TOTAL', '0');
		expect(
			await decideNewUser(db, { email: 'a@example.test', emailVerified: false })
		).toMatchObject({ code: 'email_not_verified' });
		expect(await decideNewUser(db, verified('a@example.test'))).toMatchObject({
			code: 'signups_paused'
		});
	});
});

// ---- deletion matrix

function writeUpload(rel: string) {
	const p = join(dir, 'uploads', rel);
	mkdirSync(join(p, '..'), { recursive: true });
	writeFileSync(p, 'x');
	return p;
}

async function addChapter(id: string, members: [string, string][]) {
	await db
		.insert(organization)
		.values({ id, name: `Chapter ${id}`, slug: id, createdAt: new Date() });
	for (const [i, [userId, role]] of members.entries())
		await db.insert(member).values({
			id: `m-${id}-${userId}`,
			organizationId: id,
			userId,
			role,
			createdAt: new Date(1000 + i)
		});
}

async function addBuild(orgId: string, userId: string, kind: 'build' | 'draft' = 'build') {
	return await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', kind },
		userId
	);
}

async function addPhotoRow(buildId: string, userId: string) {
	const rel = `photos/${buildId}/p.webp`;
	const abs = writeUpload(rel);
	await db.insert(buildPhotos).values({ buildId, kind: 'progress', path: rel, createdBy: userId });
	return abs;
}

describe('deleteAccount', () => {
	it('deletes the personal workspace with files, keeps chapter builds, and scrubs the person', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const lee = await signUp('Lee', 'lee@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		const mine = await addBuild(personal.id, pat.id);
		const myDraft = await addBuild(personal.id, pat.id, 'draft');
		const photo = await addPhotoRow(mine, pat.id);
		await addChapter('c1', [
			[lee.id, 'owner'],
			[pat.id, 'editor']
		]);
		const shared = await addBuild('c1', pat.id);
		const sharedPhoto = await addPhotoRow(shared, pat.id);
		const chapterDraft = await addBuild('c1', pat.id, 'draft');
		// a design with a preview
		const [dsg] = await db
			.insert(colorDesigns)
			.values({ templateId, slug: 'd-pat', name: 'D', authorUserId: pat.id })
			.returning({ id: colorDesigns.id });
		const designPng = writeUpload(`designs/${dsg.id}.png`);
		await db.insert(verification).values({
			id: 'v1',
			identifier: 'pat@example.test',
			value: 'x',
			expiresAt: new Date(Date.now() + 1e6)
		});
		await db.insert(invitation).values({
			id: 'i1',
			organizationId: 'c1',
			email: 'someone@example.test',
			status: 'pending',
			expiresAt: new Date(Date.now() + 1e6),
			inviterId: pat.id
		});
		const act = await db.select().from(activity).where(eq(activity.buildId, shared));
		void act;

		const res = await deleteAccount(db, pat.id);
		expect(res.leftChapters).toEqual(['Chapter c1']);
		expect(await first(db.select().from(user).where(eq(user.id, pat.id)))).toBeUndefined();
		expect(
			await first(db.select().from(organization).where(eq(organization.id, personal.id)))
		).toBeUndefined();
		expect(await first(db.select().from(builds).where(eq(builds.id, mine)))).toBeUndefined();
		expect(await first(db.select().from(builds).where(eq(builds.id, myDraft)))).toBeUndefined();
		expect(
			await first(db.select().from(builds).where(eq(builds.id, chapterDraft)))
		).toBeUndefined();
		const kept = (await first(db.select().from(builds).where(eq(builds.id, shared))))!;
		expect(kept.createdBy).toBe(lee.id);
		expect(existsSync(photo)).toBe(false);
		expect(existsSync(sharedPhoto)).toBe(true);
		expect(existsSync(designPng)).toBe(false);
		expect(
			await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, dsg.id)))
		).toBeUndefined();
		expect(await db.select().from(session).where(eq(session.userId, pat.id))).toHaveLength(0);
		expect(await db.select().from(account).where(eq(account.userId, pat.id))).toHaveLength(0);
		expect(await db.select().from(verification)).toHaveLength(0);
		expect(
			await first(db.select().from(invitation).where(eq(invitation.id, 'i1')))
		).toBeUndefined();
		expect(
			await db
				.select()
				.from(member)
				.where(and(eq(member.userId, pat.id)))
		).toHaveLength(0);
		// others untouched
		expect(await first(db.select().from(user).where(eq(user.id, lee.id)))).toBeTruthy();
		expect(await findPersonalWorkspace(db, lee.id)).toBeTruthy();
		// the activity left in the chapter no longer names anyone
		for (const a of await db.select().from(activity).where(eq(activity.buildId, shared)))
			expect(a.userId).toBeNull();
	});

	it('refuses when the user is the only owner of a chapter with other members', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const lee = await signUp('Lee', 'lee@example.test');
		await addChapter('c1', [
			[pat.id, 'owner'],
			[lee.id, 'viewer']
		]);
		const before = (await db.select().from(user)).length;
		await expect(deleteAccount(db, pat.id)).rejects.toThrow(
			'Make someone else an owner of Chapter c1 first'
		);
		expect(await db.select().from(user)).toHaveLength(before);
		expect((await planAccountDeletion(db, pat.id)).find((f) => f.orgId === 'c1')?.fate).toBe(
			'blocked'
		);
		// once someone else owns it, it goes through
		await db
			.update(member)
			.set({ role: 'owner' })
			.where(eq(member.id, `m-c1-${lee.id}`));
		await expect(deleteAccount(db, pat.id)).resolves.toBeTruthy();
	});

	it('deletes a chapter where the user is the only member, with its files', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		await addChapter('solo', [[pat.id, 'owner']]);
		const b = await addBuild('solo', pat.id);
		const photo = await addPhotoRow(b, pat.id);
		const res = await deleteAccount(db, pat.id);
		expect(res.deletedWorkspaces).toContain('Chapter solo');
		expect(
			await first(db.select().from(organization).where(eq(organization.id, 'solo')))
		).toBeUndefined();
		expect(existsSync(photo)).toBe(false);
		expect(existsSync(join(dir, 'uploads', 'photos', b))).toBe(false);
	});

	it('unknown user is a 404', async () => {
		await expect(deleteAccount(db, 'nobody')).rejects.toBeInstanceOf(ApiError);
	});
});

describe('kit copies used from another workspace', () => {
	async function copyFor(orgId: string) {
		const id = `copy-${orgId}`;
		await db.insert(templates).values({
			id,
			slug: id,
			name: 'Copy',
			version: '1',
			ownerOrgId: orgId,
			baseTemplateId: templateId
		} as never);
		return id;
	}

	it('account deletion leaves a chapter build that used the personal kit copy on the base kit', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const lee = await signUp('Lee', 'lee@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		await addChapter('c1', [
			[pat.id, 'owner'],
			[lee.id, 'owner']
		]);
		const copy = await copyFor(personal.id);
		const b = await addBuild('c1', pat.id);
		await db.update(builds).set({ templateId: copy }).where(eq(builds.id, b));
		await expect(deleteAccount(db, pat.id)).resolves.toBeTruthy();
		const row = (await first(db.select().from(builds).where(eq(builds.id, b))))!;
		expect(row.templateId).toBe(templateId);
		expect(await first(db.select().from(templates).where(eq(templates.id, copy)))).toBeUndefined();
	});

	it('chapter deletion likewise re-points builds elsewhere', async () => {
		await signUp('Admin', 'admin@example.test');
		const owner = await signUp('Owner', 'owner@example.test');
		const r = await post('/organization/create', owner.cookie, { name: 'Gone', slug: 'gone' });
		const org = (await r.json()) as { id: string };
		const copy = await copyFor(org.id);
		const personal = (await findPersonalWorkspace(db, owner.id))!;
		const b = await addBuild(personal.id, owner.id);
		await db.update(builds).set({ templateId: copy }).where(eq(builds.id, b));
		const del = await post('/organization/delete', owner.cookie, { organizationId: org.id });
		expect(del.status).toBe(200);
		expect((await first(db.select().from(builds).where(eq(builds.id, b))))!.templateId).toBe(
			templateId
		);
	});
});

describe('deleteOwnedTemplates scope', () => {
	async function copy(orgId: string, base: string | null) {
		const id = `c-${orgId}`;
		await db.insert(templates).values({
			id,
			slug: id,
			name: 'Copy',
			version: '1',
			ownerOrgId: orgId,
			baseTemplateId: base
		} as never);
		return id;
	}

	it("deletes the doomed workspace's own build on its copy with the workspace", async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		const c = await copy(personal.id, templateId);
		const b = await addBuild(personal.id, pat.id);
		await db.update(builds).set({ templateId: c }).where(eq(builds.id, b));
		await expect(deleteAccount(db, pat.id)).resolves.toBeTruthy();
		expect(await first(db.select().from(builds).where(eq(builds.id, b)))).toBeUndefined();
		expect(await first(db.select().from(templates).where(eq(templates.id, c)))).toBeUndefined();
	});

	it('keeps a surviving chapter build on a copy with a null base, on the built-in kit', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const lee = await signUp('Lee', 'lee@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		await addChapter('c1', [
			[pat.id, 'owner'],
			[lee.id, 'owner']
		]);
		const c = await copy(personal.id, null);
		const b = await addBuild('c1', lee.id);
		await db.update(builds).set({ templateId: c }).where(eq(builds.id, b));
		await expect(deleteAccount(db, pat.id)).resolves.toBeTruthy();
		expect((await first(db.select().from(builds).where(eq(builds.id, b))))!.templateId).toBe(
			templateId
		);
		expect(await first(db.select().from(templates).where(eq(templates.id, c)))).toBeUndefined();
	});

	it('refuses with 409 and deletes nothing when no built-in kit can take the build', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const lee = await signUp('Lee', 'lee@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		await addChapter('c1', [
			[pat.id, 'owner'],
			[lee.id, 'owner']
		]);
		const c = await copy(personal.id, null);
		const b = await addBuild('c1', lee.id);
		await db.update(builds).set({ templateId: c }).where(eq(builds.id, b));
		// Make every other template a copy so none is global.
		await db.update(templates).set({ ownerOrgId: 'c1' }).where(eq(templates.id, templateId));
		await expect(deleteAccount(db, pat.id)).rejects.toMatchObject({ status: 409 });
		expect((await first(db.select().from(builds).where(eq(builds.id, b))))!.templateId).toBe(c);
		expect(await first(db.select().from(user).where(eq(user.id, pat.id)))).toBeTruthy();
	});
});

describe('pruneOldInvitations', () => {
	it('keeps the newest 50 used-up invitations, and never open or accepted ones', async () => {
		await signUp('Admin', 'admin@example.test');
		const owner = await signUp('Owner', 'owner@example.test');
		await post('/organization/create', owner.cookie, { name: 'C1', slug: 'c1' });
		const org = (await first(db.select().from(organization).where(eq(organization.slug, 'c1'))))!;
		const far = new Date(Date.now() + 86_400_000);
		const mk = async (i: number, status: string) =>
			await db.insert(invitation).values({
				id: `inv-${status}-${i}`,
				organizationId: org.id,
				email: `x${i}@example.test`,
				role: 'viewer',
				status,
				expiresAt: far,
				createdAt: new Date(1000 + i),
				inviterId: owner.id
			});
		for (let i = 0; i < 60; i++) await mk(i, 'canceled');
		await mk(100, 'accepted');
		await mk(101, 'pending');
		const r = await post('/organization/invite-member', owner.cookie, {
			email: 'new@example.test',
			role: 'viewer',
			organizationId: org.id
		});
		expect(r.status).toBe(200);
		const rows = await db.select().from(invitation).where(eq(invitation.organizationId, org.id));
		expect(rows.filter((x) => x.status === 'canceled')).toHaveLength(50);
		expect(rows.some((x) => x.id === 'inv-canceled-0')).toBe(false);
		expect(rows.some((x) => x.id === 'inv-canceled-59')).toBe(true);
		expect(rows.some((x) => x.status === 'accepted')).toBe(true);
		expect(rows.filter((x) => x.status === 'pending')).toHaveLength(2);
	});
});

describe('chapter deletion removes files (plugin endpoint)', () => {
	it('removes photos after the transaction', async () => {
		await signUp('Admin', 'admin@example.test');
		const owner = await signUp('Owner', 'owner@example.test');
		const r = await post('/organization/create', owner.cookie, { name: 'Gone', slug: 'gone' });
		const org = (await r.json()) as { id: string };
		const b = await addBuild(org.id, owner.id);
		const photo = await addPhotoRow(b, owner.id);
		const del = await post('/organization/delete', owner.cookie, { organizationId: org.id });
		expect(del.status).toBe(200);
		expect(await first(db.select().from(builds).where(eq(builds.id, b)))).toBeUndefined();
		expect(existsSync(photo)).toBe(false);
	});
});

describe('exportAccountData', () => {
	it('has profile, memberships and personal builds, photos by name only', async () => {
		await signUp('Admin', 'admin@example.test');
		const pat = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, pat.id))!;
		const b = await addBuild(personal.id, pat.id);
		await addPhotoRow(b, pat.id);
		await addChapter('c1', [[pat.id, 'editor']]);
		await addBuild('c1', pat.id);
		const data = JSON.parse(await exportAccountData(db, pat.id)) as {
			profile: { email: string };
			memberships: { name: string; personal: boolean; role: string }[];
			builds: { build: { id: string }; photos: { fileName: string }[] }[];
		};
		expect(data.profile.email).toBe('pat@example.test');
		expect(data.memberships.map((m) => m.name).sort()).toEqual(['Chapter c1', 'My builds']);
		expect(data.builds).toHaveLength(1);
		expect(data.builds[0].build.id).toBe(b);
		expect(data.builds[0].photos).toEqual([expect.objectContaining({ fileName: 'p.webp' })]);
		expect(JSON.stringify(data)).not.toContain(dir);
	});
});

describe('last site admin', () => {
	it('refuses the only site admin while other accounts exist, with a code', async () => {
		const admin = await signUp('Admin', 'admin@example.test');
		await signUp('Pat', 'pat@example.test');
		await expect(deleteAccount(db, admin.id)).rejects.toMatchObject({
			status: 409,
			code: 'last_admin'
		});
		expect(await first(db.select().from(user).where(eq(user.id, admin.id)))).toBeTruthy();
	});

	it('lets them go once another account is a site admin (ADMIN_EMAILS)', async () => {
		const admin = await signUp('Admin', 'admin@example.test');
		await signUp('Pat', 'pat@example.test');
		vi.stubEnv('ADMIN_EMAILS', 'admin@example.test, pat@example.test');
		await expect(deleteAccount(db, admin.id)).resolves.toBeTruthy();
	});

	it('refuses the only account on the server', async () => {
		const only = await signUp('Admin', 'admin@example.test');
		await expect(deleteAccount(db, only.id)).rejects.toMatchObject({ code: 'only_account' });
	});

	it('an unverified listed email is not an admin, so it is not the last one', async () => {
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test, real@example.test');
		const mk = async (id: string, verified: boolean) =>
			await db
				.insert(user)
				.values({ id, name: id, email: `${id}@example.test`, emailVerified: verified });
		await mk('boss', false);
		await mk('real', true);
		await mk('pat', true);
		// real is the only verified admin: refused
		await expect(deleteAccount(db, 'real')).rejects.toMatchObject({ code: 'last_admin' });
		// boss is listed but unverified: not an admin, deletable
		await expect(deleteAccount(db, 'boss')).resolves.toBeTruthy();
	});
});
