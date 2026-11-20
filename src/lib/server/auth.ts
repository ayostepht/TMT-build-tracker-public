import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { ac, roles } from '../permissions';
import { authSecret, e2eAuthEnabled, publicUrl, socialProviders } from './config';
import { decideNewUser, mayUseInvitations } from './auth-policy';
import * as schema from './db/schema';
import { user as userTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { first, type Db } from './db';
import { APIError } from 'better-auth/api';
import {
	assertCanAddMember,
	assertCanCreateChapter,
	assertCanInvite,
	assertCanJoinChapter,
	buildCount,
	ensurePersonalWorkspace,
	listTeams,
	isPersonalMetadata,
	isPersonalOrg,
	pruneOldInvitations
} from './teams';
import {
	emptyPlan,
	planFiles,
	removePlannedFiles,
	deleteOwnedTemplates,
	type FilePlan
} from './account';
import { ApiError, DEMO_REFUSAL, requireNotDemoId } from './access';
import { repointBuildsOffTemplates } from './builds/repoint';
import { QuotaError, quotaLimit } from './quota';
import { demoPlugin } from './demo/plugin';
import { deleteDemoUser } from './demo/cleanup';
import { e2eSignInPlugin } from './auth-e2e';

/**
 * The account fields to overwrite with null: only keys the write actually carries (or all on
 * create). The app never uses a provider's tokens, so none is stored (id token included).
 */
export function unusedTokensCleared(a: { providerId?: unknown } & Record<string, unknown>) {
	const out: Record<string, null> = {};
	const creating = 'accountId' in a;
	for (const k of [
		'accessToken',
		'refreshToken',
		'accessTokenExpiresAt',
		'refreshTokenExpiresAt',
		'scope',
		'idToken'
	])
		if (creating || k in a) out[k] = null;
	return out;
}

function sameOrigin(request?: Request): string[] {
	if (!request) return [];
	try {
		return [new URL(request.url).origin];
	} catch {
		return [];
	}
}

/**
 * Better Auth routes that exist only for passwords. Sign-in is SSO only, so none of them may
 * answer, whatever the `emailAndPassword` flag says. `disabledPaths` matches exactly, so
 * `/reset-password/:token` cannot be listed; it needs a token from `/request-password-reset`,
 * which is disabled, and no reset mail is ever sent.
 */
export const PASSWORD_PATHS = [
	'/sign-up/email',
	'/sign-in/email',
	'/request-password-reset',
	'/reset-password',
	'/change-password',
	'/change-email',
	'/set-password',
	'/verify-password',
	'/send-verification-email',
	'/verify-email'
];

/**
 * Organization endpoints nothing in the app calls. `/organization/update` could rewrite a
 * workspace's metadata (the `personal` flag) and slug; `/leave` and `/check-slug` have no UI.
 * (Team and dynamic-role endpoints are not registered at all because those plugin options are
 * off.) Everything else the app uses goes through the quota hooks below.
 */
export const ORGANIZATION_DISABLED_PATHS = [
	'/organization/update',
	'/organization/leave',
	'/organization/check-slug'
];

/** Quota refusals reach Better Auth callers as 409 `QUOTA` with the sentence as the message. */
async function quotaGuard(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof QuotaError)
			throw new APIError('CONFLICT', { code: 'QUOTA', message: e.message });
		throw e;
	}
}

/** A demo sandbox user may not create or join teams or send invitations (403 to Better Auth callers). */
async function demoGuard(db: Db, userId: string): Promise<void> {
	try {
		await requireNotDemoId(db, userId);
	} catch (e) {
		if (e instanceof ApiError) throw new APIError('FORBIDDEN', { message: DEMO_REFUSAL });
		throw e;
	}
}

/**
 * Number handed back to the plugin's own limit check, which runs right after ours with no await
 * between them in practice. Our check already passed (so the user is under the limit or exempt as a
 * site admin): a configured limit must not trip the plugin's count for an admin, an unset one keeps
 * the plugin's historical default of 100.
 */
const plugin = (limit: number | null) => (limit === null ? 100 : Number.MAX_SAFE_INTEGER);

export function createAuth(db: Db) {
	/** Files of teams being deleted, between the plugin's before and after hooks. */
	const pendingFiles = new Map<string, { plan: FilePlan; at: number }>();
	/** A failed delete never reaches the after hook: entries older than this are dropped on the next delete. */
	const PENDING_FILES_MS = 120_000;
	const social = socialProviders();
	const url = publicUrl();
	const e2e = e2eAuthEnabled();
	return betterAuth({
		// With PUBLIC_URL set, that origin is the only trusted one. Without it (development, tests),
		// the origin of each request (resolved by scripts/proxy-origin.mjs from Host /
		// X-Forwarded-*) is trusted. Cookies are only marked Secure when PUBLIC_URL is https,
		// because the scheme is fixed when the server starts.
		...(url ? { baseURL: url } : { trustedOrigins: sameOrigin }),
		advanced: {
			useSecureCookies: url ? url.startsWith('https://') : false,
			// Better Auth skips its origin (CSRF) check when NODE_ENV=test. Never skip it: the e2e
			// server runs with NODE_ENV=test and must behave like production here.
			disableOriginCheck: false,
			// The session lookup that runs on every request reads session and user in one joined query
			// instead of two round trips.
			database: { joins: true }
		},
		secret: authSecret(),
		database: drizzleAdapter(db, { provider: 'pg', schema }),
		// Sign-in is SSO only (Google, GitHub, Discord): no passwords, no generic OIDC, no email
		// verification or reset flow, so no email is ever sent.
		emailAndPassword: { enabled: false },
		socialProviders: social,
		disabledPaths: [...PASSWORD_PATHS, ...ORGANIZATION_DISABLED_PATHS],
		user: {
			additionalFields: {
				// Demo sandbox marker. `input: false`: no request or provider profile can set it; only
				// the server-side demo start (`demo/plugin.ts`) creates such users.
				isDemo: { type: 'boolean', required: false, defaultValue: false, input: false }
			}
		},
		// Failures of the OAuth round trip land on the login page, which turns the code into
		// a fixed message.
		onAPIError: { errorURL: '/login' },
		rateLimit: {
			enabled: true,
			window: 60,
			max: 120,
			customRules: {
				'/sign-in/*': { window: 60, max: 10 },
				'/callback/*': { window: 60, max: 20 },
				'/link-social': { window: 60, max: 10 }
			}
		},
		// The app never reads the provider's access/refresh tokens and stores none (see the account
		// hooks); `encryptOAuthTokens` stays on as a backstop.
		account: {
			encryptOAuthTokens: true,
			// Linking one person's Google, GitHub and Discord logins into one account is by VERIFIED
			// email only: a provider that reports the address as unverified never links, and nothing is
			// listed in `trustedProviders` (a "trusted" provider links even for an unverified address,
			// which would let someone take over an account with a Discord or GitHub profile that merely
			// claims its email). Different-email linking is off.
			accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false }
		},
		databaseHooks: {
			account: {
				create: {
					before: async (a) => {
						// A demo sandbox user cannot link a sign-in provider (it would turn a throwaway
						// user into a login).
						await demoGuard(db, a.userId);
						return { data: unusedTokensCleared(a) };
					}
				},
				update: { before: async (a) => ({ data: unusedTokensCleared(a) }) }
			},
			user: {
				create: {
					// Provider-verified email only (and the account caps), for a first SSO login. A
					// demo user created by the server skips both (it is not an account).
					before: async (u) => {
						const d = await decideNewUser(db, u);
						if (!d.ok) throw new APIError('FORBIDDEN', { code: d.code, message: d.message });
					},
					// Every account gets a personal workspace.
					after: async (u) => {
						await ensurePersonalWorkspace(db, { id: u.id, name: u.name });
					}
				}
			},
			session: {
				create: {
					before: async (session) => {
						const v = await first(
							db
								.select({ emailVerified: userTable.emailVerified, isDemo: userTable.isDemo })
								.from(userTable)
								.where(eq(userTable.id, session.userId))
						);
						// No session for an unverified email (demo users have none by design), checked
						// before any early return.
						if (!v?.isDemo && !v?.emailVerified)
							throw new APIError('FORBIDDEN', {
								code: 'email_not_verified',
								message: 'Your email address is not verified.'
							});
						// The IP address is not stored on sessions (privacy). Not `advanced.ipAddress.
						// disableIpTracking`: that also switches the IP-keyed rate limiter off.
						const noIp = { ...session, ipAddress: '' };
						if ((session as { activeOrganizationId?: string | null }).activeOrganizationId)
							return { data: noIp };
						// The user's after-create hook may not have run yet; ensure is idempotent.
						const u = await first(
							db
								.select({ name: userTable.name })
								.from(userTable)
								.where(eq(userTable.id, session.userId))
						);
						if (!u) return { data: noIp };
						const { id } = await ensurePersonalWorkspace(db, { id: session.userId, name: u.name });
						// Users who already belong to real teams keep their own default (see the app layout).
						if ((await listTeams(db, session.userId)).some((t) => !t.personal))
							return { data: noIp };
						return { data: { ...noIp, activeOrganizationId: id } };
					}
				}
			}
		},
		hooks: {
			// Signing out of a demo deletes it at once (its builds, files and the user). Whoever calls
			// /sign-out with a demo session cookie gets this, whatever page they came from.
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== '/sign-out') return;
				const s = await getSessionFromCtx(ctx, { disableRefresh: true }).catch(() => null);
				const u = s?.user as { id: string; isDemo?: boolean } | undefined;
				if (u?.isDemo === true) {
					try {
						await deleteDemoUser(db, u.id);
					} catch (e) {
						console.error('[tmt] demo sign-out cleanup failed', e);
					}
				}
			})
		},
		plugins: [
			organization({
				ac,
				roles,
				creatorRole: 'owner',
				// The plugin checks these before its own hooks, and they are its hard bounds (our hooks
				// cannot share a transaction with the plugin's insert). The checks throw our sentence.
				// Personal workspaces are not teams and never reach the plugin's endpoints.
				organizationLimit: async (u) => {
					await demoGuard(db, u.id);
					await quotaGuard(() => assertCanCreateChapter(db, u.id));
					return false;
				},
				membershipLimit: async (u, org) => {
					await quotaGuard(() => assertCanAddMember(db, u.id, org.id));
					return plugin(quotaLimit('membersPerChapter'));
				},
				invitationLimit: async ({ user: u, organization: org }) => {
					await demoGuard(db, u.id);
					await quotaGuard(() => assertCanInvite(db, u.id, org.id));
					return plugin(quotaLimit('pendingInvitesPerChapter'));
				},
				// Accepting, declining and reading an invitation needs a verified email (Better Auth
				// checks this on the invitation routes).
				requireEmailVerificationOnInvitation: true,
				organizationHooks: {
					// Belt and braces for the option above, on the accept path itself.
					beforeAcceptInvitation: async ({ user: u, organization: org }) => {
						if (!mayUseInvitations(u as { emailVerified?: boolean; isDemo?: boolean }))
							throw new APIError('FORBIDDEN', {
								message: 'Sign in with a verified email address to accept an invitation'
							});
						await demoGuard(db, u.id);
						await quotaGuard(() => assertCanJoinChapter(db, u.id, org.id));
					},
					// Personal workspaces are created by the server only.
					beforeCreateOrganization: async ({ organization: org, user: u }) => {
						await demoGuard(db, u.id);
						if (isPersonalMetadata(org.metadata))
							throw new APIError('BAD_REQUEST', { message: 'Reserved organization metadata' });
						await quotaGuard(() => assertCanCreateChapter(db, u.id));
					},
					// Server-side adds (no HTTP route): same caps as joining.
					beforeAddMember: async ({ user: u, organization: org }) => {
						if (await isPersonalOrg(db, org.id)) return;
						await demoGuard(db, u.id);
						await quotaGuard(() => assertCanAddMember(db, u.id, org.id));
					},
					beforeCreateInvitation: async ({ organization: org, inviter }) => {
						await demoGuard(db, inviter.id);
						if (isPersonalMetadata(org.metadata) || (await isPersonalOrg(db, org.id)))
							throw new APIError('BAD_REQUEST', {
								message: 'Create a team to invite people; My builds is just for you'
							});
						await quotaGuard(() => assertCanInvite(db, inviter.id, org.id));
						// Keep the invitation table bounded under invite/cancel loops.
						await pruneOldInvitations(db, org.id);
					},
					beforeDeleteOrganization: async ({ organization: org }) => {
						if (
							(isPersonalMetadata(org.metadata) || (await isPersonalOrg(db, org.id))) &&
							(await buildCount(db, org.id)) > 0
						)
							throw new APIError('BAD_REQUEST', {
								message: 'Move or delete the builds in My builds first'
							});
						// The rows cascade away with the team; list their files first, remove them after.
						const plan = await planFiles(db, { orgIds: [org.id] });
						// Builds in other workspaces that use this team's kit copies go back to the base kit.
						// One transaction: a refusal (409) leaves the team untouched. The plugin has already
						// checked session, membership and the delete permission before this hook, and its own
						// delete is a single statement that our part has cleared of FK blockers.
						try {
							await db.transaction(async (tx) => {
								await repointBuildsOffTemplates(tx, plan.templateIds);
								await deleteOwnedTemplates(tx, plan.templateIds, [org.id]);
							});
						} catch (e) {
							if (e instanceof ApiError) throw new APIError('CONFLICT', { message: e.message });
							throw e;
						}
						const now = Date.now();
						for (const [k, v] of pendingFiles)
							if (now - v.at > PENDING_FILES_MS) pendingFiles.delete(k);
						pendingFiles.set(org.id, { plan, at: now });
					},
					afterDeleteOrganization: async ({ organization: org }) => {
						const plan: FilePlan = pendingFiles.get(org.id)?.plan ?? emptyPlan();
						pendingFiles.delete(org.id);
						await removePlannedFiles(plan);
					}
				}
			}),
			// Server-only endpoint that starts a demo sandbox (never routed over HTTP).
			demoPlugin(db),
			// Test-only sign-in, present only when `e2eAuthEnabled()` (see config.ts).
			...(e2e ? [e2eSignInPlugin()] : [])
		]
	});
}

export type Auth = ReturnType<typeof createAuth>;
