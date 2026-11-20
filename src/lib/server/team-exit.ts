/**
 * Leaving a team and deleting a team. No schema change; one implementation of "what goes with a
 * team" (`deleteWorkspaceRows` in account.ts, the same code account deletion runs for a team only
 * the user belongs to).
 *
 * Everything that removes members or changes roles runs as one transaction behind the per-team
 * advisory lock `team:<orgId>` (and then locks the member rows): leaving, removing a member,
 * changing a role, deleting the team, and account deletion (`lockTeamsOf` in account.ts, which
 * takes `site-admins` first and then its team locks in sorted order; no other code takes both).
 * The Better Auth endpoints that could write members outside it are disabled over HTTP
 * (`ORGANIZATION_DISABLED_PATHS`); accepting an invitation only adds members, and
 * `/organization/delete` removes the whole team. So two owners leaving at once (or one leaving
 * while another deletes their account) cannot leave a team without an owner. They write the
 * member and organization rows directly, like account deletion, because Better Auth's endpoints
 * run on their own connection and cannot share our lock or transaction; the app registers no
 * Better Auth hook on member removal, and the delete hook's work (kit copies, files) is what
 * `deleteWorkspaceRows` already does. Files on disk go after the commit and never fail the call.
 *
 * Leaving: the member row goes. The sole owner of a team with other members must name an heir
 * first; the heir becomes an owner in the same transaction. Builds the leaver created move to the
 * heir (the chosen one, else another owner, else the longest-standing member: the same
 * `reassignCreatedBuilds` account deletion uses), printers and custom filaments they added too.
 * Part assignments to them are cleared, their Studio drafts in this team are deleted (with files),
 * and sessions that had the team active forget it. Activity and run history keeps their name.
 *
 * Deleting: owners only, with the team's exact name typed. Everything of the team goes: builds
 * with plates, runs, activity and photo rows, photo/plate/3MF files, printers and their encrypted
 * secrets, invitations, memberships, custom filaments, settings, kit copies with their files and
 * designs. Sessions of every member forget the team. Other users' accounts and other teams stay.
 */
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { ApiError, normalizeRole } from './access';
import {
	deleteWorkspaceRows,
	emptyPlan,
	planFiles,
	pickHeir,
	reassignCreatedBuilds,
	removePlannedFiles,
	type FilePlan
} from './account';
import { advisoryLock, first, type Db, type DbOrTx } from './db';
import {
	buildParts,
	builds,
	customFilaments,
	invitation,
	member,
	organization,
	printers,
	session,
	user
} from './db/schema';
import { isPersonalMetadata } from './teams';

export class TeamExitError extends ApiError {
	constructor(
		status: number,
		message: string,
		public code:
			'only_member' | 'needs_heir' | 'wrong_name' | 'not_owner' | 'personal' | 'self' | 'last_owner'
	) {
		super(status, message);
	}
}

export const ONLY_MEMBER_MESSAGE = "You're the only one here. Delete the team instead.";
export const NEEDS_HEIR_MESSAGE = 'Choose who takes over as owner before you leave.';
export const WRONG_NAME_MESSAGE = 'Type the team name exactly as shown to confirm.';

async function loadTeam(tx: DbOrTx, orgId: string) {
	const org = await first(
		tx
			.select({ id: organization.id, name: organization.name, metadata: organization.metadata })
			.from(organization)
			.where(eq(organization.id, orgId))
	);
	if (!org) throw new ApiError(404, 'Not found');
	if (isPersonalMetadata(org.metadata))
		throw new TeamExitError(
			400,
			'My builds is your personal space, not a team. It cannot be left or deleted here.',
			'personal'
		);
	return org;
}

/** What deleting the team removes, for the confirmation screen. */
export interface TeamDeletionSummary {
	builds: number;
	/** Members other than the person asking, who lose access. */
	otherMembers: number;
	printers: number;
	pendingInvitations: number;
}

export async function teamDeletionSummary(
	db: DbOrTx,
	orgId: string,
	userId: string
): Promise<TeamDeletionSummary> {
	const n = async (q: PromiseLike<{ n: number }[]>) => (await first(q))?.n ?? 0;
	const [b, m, p, i] = await Promise.all([
		n(
			db
				.select({ n: count() })
				.from(builds)
				.where(and(eq(builds.organizationId, orgId), eq(builds.kind, 'build')))
		),
		n(
			db
				.select({ n: count() })
				.from(member)
				.where(and(eq(member.organizationId, orgId), ne(member.userId, userId)))
		),
		n(db.select({ n: count() }).from(printers).where(eq(printers.organizationId, orgId))),
		n(
			db
				.select({ n: count() })
				.from(invitation)
				.where(and(eq(invitation.organizationId, orgId), eq(invitation.status, 'pending')))
		)
	]);
	return { builds: b, otherMembers: m, printers: p, pendingInvitations: i };
}

/** Everyone who could take over as owner: the other members, oldest first. */
export async function otherMembers(db: DbOrTx, orgId: string, userId: string) {
	return (
		await db
			.select({ userId: member.userId, name: user.name, email: user.email, role: member.role })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(and(eq(member.organizationId, orgId), ne(member.userId, userId)))
			.orderBy(asc(member.createdAt), asc(member.id))
	).map((m) => ({ ...m, role: normalizeRole(m.role) }));
}

const LAST_OWNER_MESSAGE = 'A team needs at least one owner. Make someone else an owner first.';

/** Lock the team's member rows (after the advisory lock) and return them. */
async function lockMembers(tx: DbOrTx, orgId: string) {
	return tx
		.select({ id: member.id, userId: member.userId, role: member.role })
		.from(member)
		.where(eq(member.organizationId, orgId))
		.orderBy(asc(member.createdAt), asc(member.id))
		.for('update');
}

/** Post-condition checked before commit: at least one owner remains (else the transaction rolls back). */
async function assertOwnerRemains(tx: DbOrTx, orgId: string): Promise<void> {
	const owners = (
		await tx.select({ role: member.role }).from(member).where(eq(member.organizationId, orgId))
	).filter((m) => normalizeRole(m.role) === 'owner');
	if (!owners.length) throw new Error('team would be left without an owner');
}

/**
 * Take one member out of the team inside the caller's transaction (the shared part of leaving and
 * being removed): their drafts here are deleted, builds they created, printers and custom filaments
 * they added go to `heir`, part assignments are cleared, the member row goes and sessions that had
 * the team active forget it. Returns the files to remove after commit.
 */
async function detachMember(
	tx: DbOrTx,
	orgId: string,
	userId: string,
	memberId: string,
	heir: string
): Promise<FilePlan> {
	let plan: FilePlan = emptyPlan();
	const drafts = (
		await tx
			.select({ id: builds.id })
			.from(builds)
			.where(
				and(
					eq(builds.organizationId, orgId),
					eq(builds.createdBy, userId),
					eq(builds.kind, 'draft')
				)
			)
	).map((b) => b.id);
	if (drafts.length) {
		plan = await planFiles(tx, { buildIds: drafts });
		await tx.delete(builds).where(inArray(builds.id, drafts));
	}
	const orphans = await reassignCreatedBuilds(
		tx,
		userId,
		eq(builds.organizationId, orgId),
		new Map([[orgId, heir]])
	);
	if (orphans.length) throw new Error('unreachable: an heir exists');
	await tx
		.update(printers)
		.set({ createdBy: heir })
		.where(and(eq(printers.organizationId, orgId), eq(printers.createdBy, userId)));
	await tx
		.update(customFilaments)
		.set({ createdBy: heir })
		.where(and(eq(customFilaments.organizationId, orgId), eq(customFilaments.createdBy, userId)));
	await tx
		.update(buildParts)
		.set({ assigneeUserId: null })
		.where(
			and(
				eq(buildParts.assigneeUserId, userId),
				inArray(
					buildParts.buildId,
					tx.select({ id: builds.id }).from(builds).where(eq(builds.organizationId, orgId))
				)
			)
		);
	await tx.delete(member).where(eq(member.id, memberId));
	await tx
		.update(session)
		.set({ activeOrganizationId: null })
		.where(and(eq(session.userId, userId), eq(session.activeOrganizationId, orgId)));
	return plan;
}

/**
 * Remove the user from the team. `heirUserId` is required (and must be another member) when the
 * user is the only owner and others remain; that member becomes an owner first. Throws
 * `TeamExitError`/`ApiError`; nothing changes on a refusal.
 */
export async function leaveTeam(
	db: Db,
	userId: string,
	orgId: string,
	heirUserId?: string | null
): Promise<{ newOwnerId: string | null }> {
	let plan: FilePlan = emptyPlan();
	let newOwnerId: string | null = null;
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'team:' + orgId);
		await loadTeam(tx, orgId);
		const rows = await lockMembers(tx, orgId);
		const me = rows.find((r) => r.userId === userId);
		if (!me) throw new ApiError(404, 'Not found');
		const others = rows.filter((r) => r.userId !== userId);
		if (!others.length) throw new TeamExitError(409, ONLY_MEMBER_MESSAGE, 'only_member');

		let heir: string | undefined;
		const soleOwner =
			normalizeRole(me.role) === 'owner' && !others.some((o) => normalizeRole(o.role) === 'owner');
		if (soleOwner) {
			const chosen = others.find((o) => o.userId === heirUserId);
			if (!chosen) throw new TeamExitError(409, NEEDS_HEIR_MESSAGE, 'needs_heir');
			// Promote first, and verify it took: the team never has zero owners.
			const promoted = await tx
				.update(member)
				.set({ role: 'owner' })
				.where(eq(member.id, chosen.id))
				.returning({ id: member.id });
			if (!promoted.length) throw new TeamExitError(409, NEEDS_HEIR_MESSAGE, 'needs_heir');
			heir = chosen.userId;
			newOwnerId = heir;
		} else {
			heir = await pickHeir(tx, orgId, userId);
		}
		plan = await detachMember(tx, orgId, userId, me.id, heir!);
		await assertOwnerRemains(tx, orgId);
	});
	await removePlannedFiles(plan);
	return { newOwnerId };
}

/**
 * An owner removes another member. Same handover as leaving (builds, printers and filaments they
 * added go to another owner, drafts are deleted, sessions forget the team). Refuses your own row.
 * Before this, the Better Auth call only deleted the member row: their builds still named them as
 * creator and their sessions kept the team as active.
 */
export async function removeTeamMember(
	db: Db,
	actorId: string,
	orgId: string,
	memberId: string
): Promise<void> {
	let plan: FilePlan = emptyPlan();
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'team:' + orgId);
		await loadTeam(tx, orgId);
		const rows = await lockMembers(tx, orgId);
		const actor = rows.find((r) => r.userId === actorId);
		if (!actor) throw new ApiError(404, 'Not found');
		if (normalizeRole(actor.role) !== 'owner')
			throw new TeamExitError(403, 'Only team owners can do this.', 'not_owner');
		const target = rows.find((r) => r.id === memberId);
		if (!target) throw new ApiError(404, 'That member was not found.');
		if (target.userId === actorId)
			throw new TeamExitError(400, 'To remove yourself, use "Leave this team" below.', 'self');
		const heir = await pickHeir(tx, orgId, target.userId);
		if (!heir) throw new Error('unreachable: the actor is a member');
		plan = await detachMember(tx, orgId, target.userId, target.id, heir);
		await assertOwnerRemains(tx, orgId);
	});
	await removePlannedFiles(plan);
}

/** An owner changes a member's role. The last owner cannot be demoted. */
export async function changeMemberRole(
	db: Db,
	actorId: string,
	orgId: string,
	memberId: string,
	role: string
): Promise<void> {
	if (!['owner', 'editor', 'viewer'].includes(role)) throw new ApiError(400, 'Unknown role');
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'team:' + orgId);
		await loadTeam(tx, orgId);
		const rows = await lockMembers(tx, orgId);
		const actor = rows.find((r) => r.userId === actorId);
		if (!actor) throw new ApiError(404, 'Not found');
		if (normalizeRole(actor.role) !== 'owner')
			throw new TeamExitError(403, 'Only team owners can do this.', 'not_owner');
		const target = rows.find((r) => r.id === memberId);
		if (!target) throw new ApiError(404, 'That member was not found.');
		const owners = rows.filter((r) => normalizeRole(r.role) === 'owner');
		if (normalizeRole(target.role) === 'owner' && role !== 'owner' && owners.length <= 1)
			throw new TeamExitError(409, LAST_OWNER_MESSAGE, 'last_owner');
		const done = await tx
			.update(member)
			.set({ role })
			.where(eq(member.id, target.id))
			.returning({ id: member.id });
		if (!done.length) throw new ApiError(404, 'That member was not found.');
		await assertOwnerRemains(tx, orgId);
	});
}

/**
 * Delete the team and everything in it. Owners only; `typedName` must equal the team's name
 * (surrounding spaces ignored). Throws `TeamExitError`/`ApiError`; nothing changes on a refusal.
 */
export async function deleteTeam(
	db: Db,
	userId: string,
	orgId: string,
	typedName: string
): Promise<void> {
	let plan: FilePlan = emptyPlan();
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'team:' + orgId);
		const org = await loadTeam(tx, orgId);
		const me = await first(
			tx
				.select({ role: member.role })
				.from(member)
				.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		);
		if (!me) throw new ApiError(404, 'Not found');
		if (normalizeRole(me.role) !== 'owner')
			throw new TeamExitError(403, 'Only team owners can delete the team.', 'not_owner');
		if (typedName.trim() !== org.name.trim())
			throw new TeamExitError(400, WRONG_NAME_MESSAGE, 'wrong_name');
		await tx
			.update(session)
			.set({ activeOrganizationId: null })
			.where(eq(session.activeOrganizationId, orgId));
		plan = await deleteWorkspaceRows(tx, [orgId]);
	});
	await removePlannedFiles(plan);
}
