import { eq } from 'drizzle-orm';
import type { PartPlacement, TemplateModelInfo } from '#lib/domain/types.ts';
import { first, type DbOrTx } from '../db/index.ts';
import { templateModels, templatePartPlacements } from '../db/schema.ts';
import { hardwareModelUrl } from './hardware.ts';

/** The template's 3D model as the viewer needs it (same shape as `BuildView.model`), or null before the first import. */
export async function loadTemplateModelInfo(
	db: DbOrTx,
	templateId: string
): Promise<TemplateModelInfo | null> {
	const row = await first(
		db.select().from(templateModels).where(eq(templateModels.templateId, templateId))
	);
	if (!row) return null;
	return {
		url: `/api/templates/${encodeURIComponent(templateId)}/model.glb?v=${encodeURIComponent(row.version)}`,
		hardwareUrl: hardwareModelUrl(templateId),
		version: row.version,
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
