import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { ApiError, isSiteAdmin, requireNotDemo, type SiteAdminCandidate } from '../access.ts';
import { isPublicMode } from '../config.ts';
import { requireUserId } from '../api.ts';
import { first, getDb, type DbOrTx } from '../db/index.ts';
import { templates } from '../db/schema.ts';
import { canManageTemplate } from '../templates/fork.ts';

/**
 * Who may change a template's kit files (404 for everyone else, and for a missing template):
 * site admins for the global kits, owners and editors of the owning workspace for a workspace's
 * own copy (made from "Upload your own files" in the setup wizard).
 */
export async function assertTemplateAdmin(
	db: DbOrTx,
	user: SiteAdminCandidate,
	templateId: string
): Promise<void> {
	const t = await first(
		db.select({ id: templates.id }).from(templates).where(eq(templates.id, templateId))
	);
	if (!t || !(await canManageTemplate(db, user, templateId))) throw new ApiError(404, 'Not found');
}

/** Request-handler version: 401 when signed out. Returns the user id. */
export async function requireAdminForTemplate(
	event: RequestEvent,
	templateId: string
): Promise<string> {
	const userId = requireUserId(event);
	// A demo user cannot change kit files, even of a workspace copy.
	requireNotDemo(event.locals.user);
	await assertTemplateAdmin(getDb(), event.locals.user!, templateId);
	return userId;
}

/**
 * Converting a STEP zip to a 3D model runs OpenCascade in a child process with a large memory
 * budget, which a small hosted machine cannot give to every editor. On the hosted site only site
 * admins may start one (403 with a plain message for everyone else). Kit copies and print-geometry
 * imports do not use the converter and are not affected.
 */
export async function assertModelConversionAllowed(
	db: DbOrTx,
	user: SiteAdminCandidate
): Promise<void> {
	if (isPublicMode() && !(await isSiteAdmin(db, user)))
		throw new ApiError(403, 'Only site admins can convert 3D models on the hosted site.');
}
