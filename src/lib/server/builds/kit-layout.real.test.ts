// Runs only when TMT_PACK_DIR points at a directory with the kit pack and its index.json (never in CI).
// The maintainer's report: on an Elegoo Centauri Carbon (256 x 256 + cutter keep-out) a standard-palette
// build got plates re-arranged and merged (Handle Left + Headrest Brace, Cushion Top + Soft Headrest,
// Cushion Base + Push Handle Grip) that are single-part plates in the kit's default layout.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = process.env.TMT_PACK_DIR;

describe.skipIf(!dir || !existsSync(dir!))('kit layout against the real kit pack', () => {
	it(
		'a standard-palette build keeps the kit plates; lone kit plates stay alone',
		{
			timeout: 900_000
		},
		async () => {
			const { first } = await import('../db');
			const { createTestDb } = await import('../db/testing');
			const schema = await import('../db/schema');
			const { templateSeeds } = await import('../seed');
			const { seedTemplates } = await import('../seed/run');
			const { installKitPacks } = await import('../kitpack/install');
			const { createBuild } = await import('./create');
			const { buildArrangement } = await import('./plates');
			const { loadBuildView } = await import('./view');
			const { previewExport } = await import('../threemf-export/index');
			const { catalogPrinter } = await import('#lib/printers/catalog.ts');
			const { printerFromCatalog } = await import('#lib/printers/printer.ts');
			const db = await createTestDb();
			await seedTemplates(db, templateSeeds);
			await installKitPacks(db, { dir: dir!, download: false });
			const tpl = (await first(db.select().from(schema.templates)))!;
			await db
				.insert(schema.organization)
				.values({ id: 'org-r', name: 'S', slug: 's', createdAt: new Date() });
			await db
				.insert(schema.user)
				.values({ id: 'u-r', name: 'S', email: 's@example.test', createdAt: new Date() });
			await db.insert(schema.member).values({
				id: 'm-r',
				organizationId: 'org-r',
				userId: 'u-r',
				role: 'owner',
				createdAt: new Date()
			});
			const printer = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);
			const id = await createBuild(
				db,
				{ organizationId: 'org-r', templateId: tpl.id, designId: null, name: 'Std', printer },
				'u-r'
			);
			const kitId = await createBuild(
				db,
				{
					organizationId: 'org-r',
					templateId: tpl.id,
					designId: null,
					name: 'Kit',
					printer,
					plateLayout: 'xpa'
				},
				'u-r'
			);
			const mine = (await buildArrangement(db, id, 'u-r')).plates;
			const kit = (await loadBuildView(db, kitId, 'u-r'))!.plates;
			const lone = kit.filter((p) => p.parts.length === 1);
			expect(lone.length).toBeGreaterThan(10);
			for (const k of lone) {
				const got = mine.find((p) => p.number === k.number)!;
				expect(got.parts, `plate ${k.number} ${k.name}`).toEqual(k.parts);
			}
			// the three plates of the report: alone, as in the kit
			for (const slug of ['handle-left', 'cushion-top', 'cushion-base'])
				expect(mine.find((p) => p.parts.includes(slug))!.parts).toEqual([slug]);
			// all but the plates that cannot be used on this bed are the kit's, in the kit's numbers
			const same = kit.filter(
				(k) => mine.find((p) => p.number === k.number)?.parts.join() === k.parts.join()
			);
			expect(same.length).toBeGreaterThanOrEqual(kit.length - 2);
			expect(mine.length).toBeLessThanOrEqual(kit.length + 2);
			const out = mine.map((p) => `${p.number} ${p.name} [${p.parts.join(',')}]`).join('\n');
			console.log(`PLATES ${mine.length} (kit ${kit.length})\n${out}`);
			const pre = await previewExport(db, id, 'u-r', { flavor: 'orca' });
			console.log(
				'EXPORT WARNINGS',
				JSON.stringify(pre.warnings.map((w) => w.severity + ':' + w.code))
			);
			expect(pre.warnings.filter((w) => w.severity === 'error')).toEqual([]);
		}
	);
});
