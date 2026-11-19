import { and, eq, inArray, ne } from 'drizzle-orm';
import { first, type DbOrTx } from '../db';
import { builds, templates } from '../db/schema';

/**
 * Re-point every build that uses one of these workspace-owned kit copies from ANOTHER workspace
 * to the copy's base (global) template. Used before a copy is deleted with its workspace (chapter
 * or account deletion) and when a build moves out of the workspace that owns its copy, so
 * `builds.template_id` never references a kit copy the build's workspace does not own.
 *
 * Safe for the build: builds snapshot their parts, plates and filaments at creation and the copy
 * shares the base's part slugs, so progress, plates and colors carry over; only copy-specific
 * kit edits (renamed parts, replaced model files) stop applying to that build. Same effect as
 * choosing the built-in kit in the setup wizard.
 *
 * Call inside the caller's transaction. Ids that are not copies (no owner or no base) are
 * skipped. Returns the number of builds re-pointed.
 */
export async function repointBuildsOffTemplates(
	tx: DbOrTx,
	templateIds: string[]
): Promise<number> {
	if (!templateIds.length) return 0;
	const copies = await tx
		.select({ id: templates.id, owner: templates.ownerOrgId, base: templates.baseTemplateId })
		.from(templates)
		.where(inArray(templates.id, templateIds));
	let moved = 0;
	for (const c of copies) {
		if (!c.owner || !c.base) continue;
		const base = await first(
			tx
				.select({ id: templates.id, owner: templates.ownerOrgId })
				.from(templates)
				.where(eq(templates.id, c.base))
		);
		if (!base) continue;
		moved += (
			await tx
				.update(builds)
				.set({ templateId: base.id })
				.where(and(eq(builds.templateId, c.id), ne(builds.organizationId, c.owner)))
				.returning({ id: builds.id })
		).length;
	}
	return moved;
}
