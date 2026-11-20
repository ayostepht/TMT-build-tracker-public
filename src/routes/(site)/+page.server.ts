import { eq } from 'drizzle-orm';
import { getDb, type Db } from '#lib/server/db/index.ts';
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
type Hero = {
	model: TemplateModelInfo;
	partRoles: Record<string, string>;
	hidden: string[];
};

/**
 * The hero is the same for every visitor and changes only when a kit pack is installed or replaced,
 * so it is kept for a short while instead of costing the signed-out home page three database round
 * trips on every visit. Only a found model is kept: a missing kit (still installing) is looked up again.
 */
const HERO_TTL_MS = 30_000;
// Keyed by the database handle, so a test (or a restart onto another pool) never sees another database's hero.
let heroCache: { at: number; db: Db; value: Hero } | null = null;

async function heroModel(): Promise<Hero | null> {
	let db: Db;
	try {
		db = getDb();
	} catch {
		return null;
	}
	if (heroCache && heroCache.db === db && Date.now() - heroCache.at < HERO_TTL_MS)
		return heroCache.value;
	const value = await loadHeroModel(db);
	if (value) heroCache = { at: Date.now(), db, value };
	return value;
}

async function loadHeroModel(db: Db): Promise<Hero | null> {
	try {
		const t = await defaultTemplate(db);
		if (!t) return null;
		// Independent of each other: one round trip's wait, not two.
		const [info, rows] = await Promise.all([
			loadTemplateModelInfo(db, t.id),
			db
				.select({ slug: templateParts.slug, role: templateParts.defaultRole })
				.from(templateParts)
				.where(eq(templateParts.templateId, t.id))
		]);
		if (!info) return null;
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
