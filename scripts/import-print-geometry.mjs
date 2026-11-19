// Import print geometry (the MakeGood profile 3MF, or a zip of 3MFs) for a kit without the
// browser upload: the same code as the kit admin page ("Print geometry"), for big files.
// Run inside the app container (the code it uses is bundled into build/cli by `npm run build`):
//
//   node scripts/import-print-geometry.mjs --list
//   node scripts/import-print-geometry.mjs --template tmt \
//     --file /import/profile.3mf [--file /import/harness.zip]
//
// The database is DATABASE_URL (or --database-url); meshes are written under
// <data dir>/uploads/print/<template>/ (DATA_DIR or --data-dir, default /data). Stop nothing: the
// running app picks the rows up on the next request. `--init` migrates and seeds a brand new
// database first (scratch copies); the app does that itself at start.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const usage = `Usage:
  import-print-geometry.mjs --list [--database-url <url>] [--data-dir <dir>]
  import-print-geometry.mjs --template <slug> --file <profile.3mf|zip> [--file <more>] [--database-url <url>] [--data-dir <dir>] [--init]`;

let args;
try {
	args = parseArgs({
		options: {
			'database-url': { type: 'string' },
			'data-dir': { type: 'string' },
			template: { type: 'string' },
			file: { type: 'string', multiple: true },
			init: { type: 'boolean', default: false },
			list: { type: 'boolean', default: false },
			help: { type: 'boolean', default: false }
		}
	}).values;
} catch (e) {
	console.error(e.message + '\n' + usage);
	process.exit(2);
}
if (args.help) {
	console.log(usage);
	process.exit(0);
}

// The bundle reads both at call time; set them before it runs.
const databaseUrl = args['database-url'] || process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('Set DATABASE_URL (or pass --database-url).\n' + usage);
	process.exit(2);
}
process.env.DATABASE_URL = databaseUrl;
if (args['data-dir']) process.env.DATA_DIR = resolve(args['data-dir']);
let cli;
try {
	cli = await import(new URL('../build/cli/geometry-cli.js', import.meta.url));
} catch (e) {
	console.error(
		`Cannot load build/cli/geometry-cli.js (${e.code ?? e.message}). Run \`npm run build\` first.`
	);
	process.exit(1);
}

let db;
try {
	db = cli.openDb(databaseUrl);
	if (args.init) await cli.initDb(db);
	if (args.list || !args.file?.length) {
		if (!args.list) throw new Error('--file is required\n' + usage);
		for (const t of await cli.listTemplates(db)) {
			const rows = await cli.listPrintGeometry(db, t.id);
			const mesh = rows.filter((r) => r.hasMesh && r.source !== 'seed').length;
			console.log(
				`template ${t.slug}  ${t.name}  (${mesh}/${rows.length} parts with imported geometry)`
			);
		}
		await cli.closeDb(db);
		process.exit(0);
	}
	if (!args.template) throw new Error('--template is required\n' + usage);
	const tpl = await cli.findTemplate(db, args.template);
	for (const f of args.file) if (!existsSync(f)) throw new Error(`File not found: ${f}`);
	const t0 = Date.now();
	for (const { file, result } of await cli.importFiles(db, tpl.id, args.file)) {
		console.log(`${file}: imported ${result.imported} part(s)`);
		for (const r of result.report) {
			console.log(
				`  ${r.file}: matched ${r.matched} (${r.ms} ms)${r.parts.length ? ' -> ' + r.parts.join(', ') : ''}`
			);
			if (r.unmatched.length) console.log(`    unmatched objects: ${r.unmatched.length}`);
			for (const w of r.warnings) console.log('    warning: ' + w);
		}
	}
	const rows = await cli.listPrintGeometry(db, tpl.id);
	console.log(
		`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${rows.filter((r) => r.hasMesh && r.source !== 'seed').length} of ${rows.length} parts of ${tpl.slug} have print geometry`
	);
	await cli.closeDb(db);
} catch (e) {
	console.error('Error: ' + (e?.message ?? e));
	if (db) await cli.closeDb(db).catch(() => {});
	process.exit(1);
}
