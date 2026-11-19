import { redirect } from '@sveltejs/kit';
import { and, inArray, isNull } from 'drizzle-orm';
import { templates } from '#lib/server/db/schema.ts';
import { getDb } from '#lib/server/db/index.ts';
import { listGallery } from '#lib/server/designs/gallery.ts';
import { loadTemplateModelInfo } from '#lib/server/models/info.ts';
import type { TemplateModelInfo } from '#lib/domain/types.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// The (app) layout already guards the route; this keeps the type honest and never lists to a visitor.
	if (!locals.user) redirect(303, '/login?redirect=%2Fgallery');
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const family = url.searchParams.get('family') ?? '';
	const gallery = await listGallery(getDb(), locals.user.id, {
		q,
		family,
		page: Number(url.searchParams.get('page')) || 1
	});
	// The chair each card is drawn on when the design has no saved picture (null: no model installed).
	const models: Record<string, TemplateModelInfo | null> = {};
	// Only built-in (ownerless) kits are listed; a workspace's kit copy is never loaded here.
	const builtIn = new Set(
		(
			await getDb()
				.select({ id: templates.id })
				.from(templates)
				.where(
					and(
						inArray(templates.id, [...new Set(gallery.items.map((i) => i.templateId))]),
						isNull(templates.ownerOrgId)
					)
				)
		).map((t) => t.id)
	);
	for (const id of builtIn) models[id] = await loadTemplateModelInfo(getDb(), id);
	return { gallery, q, family, models };
};
