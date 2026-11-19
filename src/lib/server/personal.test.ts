import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAuth, type Auth } from './auth';
import { enableTestSignIn, signInTestUser } from './auth-test-helpers';
import { ApiError } from './access';
import { moveBuild } from './builds/actions';
import { createBuild } from './builds/create';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import { activity, builds, member, organization, templates, user } from './db/schema';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { ensurePersonalWorkspace, findPersonalWorkspace, listTeams } from './teams';

let db: Db;
let auth: Auth;
let templateId: string;

const signUp = (name: string, email: string) => signInTestUser(auth, name, email);

async function addChapter(id: string, userId: string, role: string) {
	await db
		.insert(organization)
		.values({ id, name: `Chapter ${id}`, slug: id, createdAt: new Date() });
	await db
		.insert(member)
		.values({ id: `m-${id}-${userId}`, organizationId: id, userId, role, createdAt: new Date() });
}

afterEach(() => {
	vi.unstubAllEnvs();
	return dropTestDb(db);
});

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	enableTestSignIn();
	auth = createAuth(db);
});

describe('personal workspace', () => {
	it('sign-up creates exactly one, owned by the user, and makes it active', async () => {
		const u = await signUp('Pat Maker', 'pat@example.test');
		const teams = await listTeams(db, u.id);
		expect(teams).toHaveLength(1);
		expect(teams[0]).toMatchObject({ personal: true, role: 'owner', name: "Pat Maker's builds" });
		expect(await db.select().from(organization)).toHaveLength(1);
		const session = await auth.api.getSession({ headers: u.headers });
		expect(session?.session.activeOrganizationId).toBe(teams[0].id);
	});

	it('gets a unique slug when two users share a name', async () => {
		await signUp('Pat', 'a@example.test');
		await signUp('Pat', 'b@example.test');
		const slugs = await db.select({ slug: organization.slug }).from(organization);
		expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
	});

	it('is created lazily for a legacy user, once', async () => {
		await db.insert(user).values({ id: 'legacy', name: 'Old Timer', email: 'old@example.test' });
		expect(await findPersonalWorkspace(db, 'legacy')).toBeNull();
		const a = await ensurePersonalWorkspace(db, { id: 'legacy', name: 'Old Timer' });
		const b = await ensurePersonalWorkspace(db, { id: 'legacy', name: 'Old Timer' });
		expect(a.created).toBe(true);
		expect(b).toEqual({ id: a.id, created: false });
		expect((await listTeams(db, 'legacy')).filter((t) => t.personal)).toHaveLength(1);
	});

	it('concurrent ensure calls create exactly one workspace', async () => {
		await db.insert(user).values({ id: 'racer', name: 'Racer', email: 'racer@example.test' });
		const results = await Promise.all(
			Array.from({ length: 5 }, () => ensurePersonalWorkspace(db, { id: 'racer', name: 'Racer' }))
		);
		expect(results.filter((x) => x.created)).toHaveLength(1);
		expect(new Set(results.map((x) => x.id)).size).toBe(1);
		expect((await listTeams(db, 'racer')).filter((t) => t.personal)).toHaveLength(1);
	});

	it('rejects invitations', async () => {
		const u = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, u.id))!;
		await expect(
			auth.api.createInvitation({
				body: { email: 'friend@example.test', role: 'viewer', organizationId: personal.id },
				headers: u.headers
			})
		).rejects.toThrow();
		// A real chapter still accepts invitations.
		const org = await auth.api.createOrganization({
			body: { name: 'Real chapter', slug: 'real-chapter' },
			headers: u.headers
		});
		const inv = await auth.api.createInvitation({
			body: { email: 'friend@example.test', role: 'viewer', organizationId: org.id },
			headers: u.headers
		});
		expect(inv.status).toBe('pending');
	});

	it('cannot be created through the organization API', async () => {
		const u = await signUp('Pat', 'pat@example.test');
		await expect(
			auth.api.createOrganization({
				body: { name: 'Sneaky', slug: 'sneaky', metadata: { personal: true } },
				headers: u.headers
			})
		).rejects.toThrow();
	});
});

describe('moveBuild', () => {
	async function setup() {
		const u = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, u.id))!;
		const buildId = await createBuild(
			db,
			{ organizationId: personal.id, templateId, designId: null, name: 'Chair' },
			u.id
		);
		return { u, personal, buildId };
	}
	const orgOf = async (id: string) =>
		(await first(db.select({ o: builds.organizationId }).from(builds).where(eq(builds.id, id))))!.o;

	it('works for an owner who is editor in the target chapter, and logs it', async () => {
		const { u, buildId } = await setup();
		await addChapter('c1', u.id, 'editor');
		await moveBuild(db, buildId, u.id, { organizationId: 'c1' });
		expect(await orgOf(buildId)).toBe('c1');
		const row = await first(
			db
				.select()
				.from(activity)
				.where(and(eq(activity.buildId, buildId), eq(activity.kind, 'build.move')))
		);
		expect(row?.payload).toMatchObject({ to: 'c1', toName: 'Chapter c1' });
	});

	it('rejects viewers of the target, non-members and personal targets', async () => {
		const { u, personal, buildId } = await setup();
		await addChapter('viewer-c', u.id, 'viewer');
		await db.insert(user).values({ id: 'someone-else', name: 'S', email: 's@example.test' });
		await addChapter('foreign', 'someone-else', 'owner');
		const move = (to: string) => moveBuild(db, buildId, u.id, { organizationId: to });
		await expect(move('viewer-c')).rejects.toMatchObject({ status: 403 });
		await expect(move('foreign')).rejects.toMatchObject({ status: 404 });
		await expect(move(personal.id)).rejects.toThrow(ApiError);
		expect(await orgOf(buildId)).toBe(personal.id);
	});

	it('is owner-only on the source and only from a personal workspace', async () => {
		const { u, buildId } = await setup();
		const other = await signUp('Other', 'other@example.test');
		await addChapter('c2', other.id, 'owner');
		await expect(moveBuild(db, buildId, other.id, { organizationId: 'c2' })).rejects.toMatchObject({
			status: 404
		});
		// A build already in a chapter cannot be moved between chapters.
		await addChapter('c3', u.id, 'owner');
		await moveBuild(db, buildId, u.id, { organizationId: 'c3' });
		await addChapter('c4', u.id, 'owner');
		await expect(moveBuild(db, buildId, u.id, { organizationId: 'c4' })).rejects.toThrow(ApiError);
	});
});

describe('deleting a personal workspace', () => {
	it('is refused while it holds builds', async () => {
		const u = await signUp('Pat', 'pat@example.test');
		const personal = (await findPersonalWorkspace(db, u.id))!;
		await createBuild(
			db,
			{ organizationId: personal.id, templateId, designId: null, name: 'Chair' },
			u.id
		);
		await expect(
			auth.api.deleteOrganization({ body: { organizationId: personal.id }, headers: u.headers })
		).rejects.toThrow();
		expect(await findPersonalWorkspace(db, u.id)).not.toBeNull();
	});
});
