import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { ApiError, isSiteAdmin } from '#lib/server/access.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { templates } from '#lib/server/db/schema.ts';
import { getDesignDetail } from '#lib/server/designs/designs.ts';
import { findSharedDesign, getGalleryItem } from '#lib/server/designs/gallery.ts';
import { loadTemplateModel } from '#lib/server/designs/model.ts';
import { inactiveSlugs } from '#lib/domain/variants.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(404, 'Not found');
	const db = getDb();
	try {
		// Only designs that are in the gallery: a private design never opens through this route.
		const shared = await findSharedDesign(db, params.slug);
		const item = await getGalleryItem(db, shared.id, locals.user.id);
		const design = await getDesignDetail(db, shared.id, locals.user.id);
		const groups =
			(
				await first(
					db
						.select({ g: templates.variantGroups })
						.from(templates)
						.where(eq(templates.id, design.templateId))
				)
			)?.g ?? [];
		return {
			item,
			design,
			model: await loadTemplateModel(db, design.templateId),
			hidden: [...inactiveSlugs(groups, null)],
			siteAdmin: await isSiteAdmin(db, locals.user)
		};
	} catch (e) {
		if (e instanceof ApiError) error(e.status as 404, e.message);
		throw e;
	}
};
