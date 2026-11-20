import { eq } from 'drizzle-orm';
import { getDb } from '#lib/server/db/index.ts';
import { templateParts } from '#lib/server/db/schema.ts';
import { loadTemplateModelInfo } from '#lib/server/models/info.ts';
import { defaultTemplate } from '#lib/server/templates/fork.ts';
import { inactiveSlugs } from '#lib/domain/variants.ts';
import type { TemplateModelInfo } from '#lib/domain/types.ts';
import type { PageServerLoad } from './$types';

/**
 * The home page's hero: the built-in MakeGood kit's model (readable signed out, see
 * `api/templates/[id]/model.glb`) and each part's default color role, so the page can paint it.
 * Null when no kit pack is installed; the page then shows only its still image.
 */
async function heroModel(): Promise<{
	model: TemplateModelInfo;
	partRoles: Record<string, string>;
	hidden: string[];
} | null> {
	try {
		const db = getDb();
		const t = await defaultTemplate(db);
		if (!t) return null;
		const info = await loadTemplateModelInfo(db, t.id);
		if (!info) return null;
		const rows = await db
			.select({ slug: templateParts.slug, role: templateParts.defaultRole })
			.from(templateParts)
			.where(eq(templateParts.templateId, t.id));
		return {
			// no hardware GLB for the hero: it is only readable by signed-in users
			model: { ...info, hardwareUrl: null },
			partRoles: Object.fromEntries(rows.map((r) => [r.slug, r.role])),
			// Parts of the variants the template does not choose by default, hidden exactly as the
			// design pages do; drawn together they z-fight in the wheel face.
			hidden: [...inactiveSlugs(t.variantGroups ?? [], null)]
		};
	} catch {
		return null;
	}
}

/** The public home is for everyone, signed in or not (the app links back to it). */
export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-cache' });
	return {
		hero: await heroModel(),
		// Fixed text only: the query string never reaches the page as text.
		notice:
			!locals.user && url.searchParams.get('notice') === 'demo-ended'
				? 'The demo was deleted.'
				: null
	};
};
