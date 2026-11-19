import { error } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { isSiteAdmin } from '#lib/server/access.ts';
import { first, getDb } from '#lib/server/db/index.ts';
import { templateModels, templateParts, templatePlates, templates } from '#lib/server/db/schema.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const db = getDb();
	if (!locals.user || !(await isSiteAdmin(db, locals.user))) error(404, 'Not found');
	const n = async (table: typeof templateParts | typeof templatePlates, id: string) =>
		(await first(db.select({ n: count() }).from(table).where(eq(table.templateId, id))))?.n ?? 0;
	const rows = await db.select().from(templates);
	const out = [];
	for (const t of rows) {
		const model = await first(
			db
				.select({ version: templateModels.version, size: templateModels.size })
				.from(templateModels)
				.where(eq(templateModels.templateId, t.id))
		);
		out.push({
			id: t.id,
			name: t.name,
			version: t.version,
			parts: await n(templateParts, t.id),
			plates: await n(templatePlates, t.id),
			variantGroups: t.variantGroups.length,
			model: model ?? null,
			owned: t.ownerOrgId !== null
		});
	}
	return { templates: out };
};
