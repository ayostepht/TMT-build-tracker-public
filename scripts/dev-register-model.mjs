// Dev only: register an existing GLB as a template's 3D model without the STEP zip.
//
//   DATABASE_URL=postgres://... DATA_DIR=./data node scripts/dev-register-model.mjs <template slug> <model.glb>
//
// Copies the GLB to <DATA_DIR>/uploads/models/<templateId>.glb (what the app serves) and
// upserts the template_models row (version = content hash, slugs = node names in the GLB).
// The server must have run once so the schema exists. Never commit the GLB.
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [templateSlug, glbFile] = process.argv.slice(2);
if (!templateSlug || !glbFile) {
	console.error(
		'usage: dev-register-model.mjs <template slug> <model.glb>  (DATABASE_URL, DATA_DIR)'
	);
	process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/tmt_dev';
const dataDir = resolve(process.env.DATA_DIR || 'data');

const glb = readFileSync(glbFile);
if (glb.toString('latin1', 0, 4) !== 'glTF') {
	console.error('Not a GLB file');
	process.exit(1);
}
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
const slugs = [
	...new Set(
		(json.nodes ?? [])
			.filter((n) => n.mesh !== undefined && n.name && !n.name.startsWith('hw:'))
			.map((n) => n.name.replace(/#\d+$/, ''))
	)
];

const sql = postgres(databaseUrl, { prepare: false, max: 1 });
try {
	const [tpl] = await sql`SELECT id FROM templates WHERE slug = ${templateSlug}`;
	if (!tpl) {
		console.error(`No template with slug "${templateSlug}"`);
		process.exit(1);
	}
	const dest = join(dataDir, 'uploads', 'models', `${tpl.id}.glb`);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(glbFile, dest);
	const version = createHash('sha256').update(glb).digest('hex').slice(0, 16);
	const note = 'registered with dev-register-model.mjs';
	await sql`
		INSERT INTO template_models (template_id, glb_path, version, size, slugs, source_note, created_at)
		VALUES (${tpl.id}, ${dest}, ${version}, ${glb.length}, ${sql.json(slugs)}, ${note}, now())
		ON CONFLICT (template_id) DO UPDATE SET glb_path = excluded.glb_path, version = excluded.version,
		  size = excluded.size, slugs = excluded.slugs, source_note = excluded.source_note, created_at = excluded.created_at`;
	console.log(
		`registered ${slugs.length} parts (${(glb.length / 1e6).toFixed(2)} MB, v${version}) for ${templateSlug}`
	);
} finally {
	await sql.end({ timeout: 5 });
}
