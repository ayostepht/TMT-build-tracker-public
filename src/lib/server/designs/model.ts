import { eq } from 'drizzle-orm';
import type { PartPlacement, TemplateModelInfo } from '#lib/domain/types.ts';
import { first, type DbOrTx } from '../db';
import { templateModels, templatePartPlacements } from '../db/schema';

/** The template's 3D model as the viewer needs it (same shape as `BuildView.model`), or null before an admin imports one. */
export async function loadTemplateModel(
	db: DbOrTx,
	templateId: string
): Promise<TemplateModelInfo | null> {
	const row = await first(
		db.select().from(templateModels).where(eq(templateModels.templateId, templateId))
	);
	if (!row) return null;
	return {
		url: `/api/templates/${encodeURIComponent(templateId)}/model.glb?v=${encodeURIComponent(row.version)}`,
		version: row.version,
		hardwareUrl: null,
		placements: (
			await db
				.select()
				.from(templatePartPlacements)
				.where(eq(templatePartPlacements.templateId, templateId))
		).map((r): PartPlacement => ({
			slug: r.slug,
			matrix: r.matrix,
			instances: r.instances,
			placed: r.placed
		})),
		slugs: row.slugs
	};
}
