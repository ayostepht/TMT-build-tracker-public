// One-command local preview with invented sample data, for reviewing changes on a Mac and a
// phone before anything is deployed. Review only: a throwaway secret, a throwaway data folder
// (data/preview/data) and database (`tmt_preview`), a manual printer. Never point it at real data.
//
//   npm run preview:demo [-- --fresh] [-- --port 5200] [-- --no-build]
//
// It builds the working tree, copies the build to data/preview/build (so later builds and
// Playwright runs do not disturb it), serves that copy, and seeds through the app's HTTP API.
//
// Needs a local Postgres (`scripts/dev-postgres.sh`). The preview uses its own database,
// `tmt_preview`, on the server DATABASE_URL points at (default: the dev Postgres); it is created
// when missing, and `--fresh` drops and recreates it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { ensureKitPack } from './preview/kitpack.mjs';
import { DEMO, seedDemo } from './preview/seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previewDir = join(root, 'data', 'preview');
const dataDir = join(previewDir, 'data');
const buildDir = join(previewDir, 'build');
const kitDir = join(previewDir, 'kitpacks');
const FLOCK = '/opt/homebrew/bin/flock';

const say = (m) => console.log(`[preview] ${m}`);
const die = (m) => {
	console.error(`[preview] ${m}`);
	process.exit(1);
};

// ---- arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
let port = 5200;
const pi = argv.indexOf('--port');
if (pi >= 0) {
	port = Number(argv[pi + 1]);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		die('--port needs a number from 1 to 65535.');
}
for (const a of argv)
	if (a.startsWith('--') && !['--fresh', '--port', '--no-build'].includes(a))
		die(`Unknown option ${a}. Options: --fresh, --port <n>, --no-build.`);
const fresh = flag('--fresh');

if (process.versions.node.split('.')[0] !== '22')
	die(
		`Node 22 is needed (this is ${process.version}); Node 25 breaks the build. Put Node 22 first on PATH.`
	);

// ---- port must be free (checked on all interfaces, as the server will bind)
const tryListen = (p, host) =>
	new Promise((ok) => {
		const s = createServer();
		s.once('error', (e) => ok(e));
		s.listen(p, host, () => s.close(() => ok(null)));
	});
const portErr = await tryListen(port, '0.0.0.0');
if (portErr)
	die(
		portErr.code === 'EADDRINUSE'
			? `Port ${port} is already in use (another preview running?). Stop it or pass --port <n>.`
			: `Cannot listen on port ${port}: ${portErr.message}`
	);

// ---- the preview database (its own database on the dev Postgres; never the dev or real one)
const serverUrl = new URL(process.env.DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/tmt_dev');
const previewDbName = 'tmt_preview';
const adminUrl = new URL(serverUrl);
adminUrl.pathname = '/postgres';
const previewUrl = new URL(serverUrl);
previewUrl.pathname = `/${previewDbName}`;
const previewDbUrl = previewUrl.toString();
{
	const admin = postgres(adminUrl.toString(), { prepare: false, max: 1, onnotice: () => {} });
	try {
		if (fresh) await admin.unsafe(`drop database if exists ${previewDbName} with (force)`);
		const [exists] = await admin`select 1 as ok from pg_database where datname = ${previewDbName}`;
		if (!exists) await admin.unsafe(`create database ${previewDbName}`);
	} catch (e) {
		die(
			`Cannot reach Postgres (${e.code ?? e.message}). Start it with scripts/dev-postgres.sh or set DATABASE_URL.`
		);
	} finally {
		await admin.end({ timeout: 5 });
	}
}

// ---- fresh: wipe the preview data folder too
if (fresh) {
	rmSync(dataDir, { recursive: true, force: true });
	say('--fresh: preview data wiped.');
}
mkdirSync(dataDir, { recursive: true });

// ---- build the working tree and copy it
if (flag('--no-build')) {
	if (!existsSync(join(buildDir, 'index.js')))
		die('--no-build: no earlier preview build in data/preview/build.');
	say('--no-build: serving the earlier build copy.');
} else {
	const tmp = `${buildDir}.new`;
	rmSync(tmp, { recursive: true, force: true });
	const script = 'npm run build && cp -R build "$1"';
	const lock = existsSync(FLOCK);
	if (lock) say('building under the e2e lock (waits if Playwright is running)...');
	else say('note: flock not installed, building without the e2e lock (brew install flock).');
	const cmd = lock
		? [FLOCK, join(root, 'node_modules', '.e2e.lock'), 'sh', '-c', script, 'sh', tmp]
		: ['sh', '-c', script, 'sh', tmp];
	const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit' });
	if (r.status !== 0) die('The build failed (output above).');
	rmSync(buildDir, { recursive: true, force: true });
	renameSync(tmp, buildDir);
	say('build copied to data/preview/build.');
}

// ---- kit pack (3D chair and print geometry)
const kit = await ensureKitPack(root, kitDir, say);
if (!kit.ok)
	say(
		`3D model and plate geometry are MISSING: ${kit.message}. Copy the .kitpack into data/preview/kitpacks/ (name and sha256 in kitpacks/index.json) and restart.`
	);

// ---- the printer catalog (for the sample build's printer)
const { build } = await import('esbuild');
const catalogFile = join(previewDir, 'catalog.mjs');
await build({
	entryPoints: [join(root, 'scripts', 'preview', 'catalog-entry.mjs')],
	outfile: catalogFile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	logLevel: 'error'
});
const catalogLib = await import(`${pathToFileURL(catalogFile).href}?t=${Date.now()}`);

// ---- the server
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', './scripts/proxy-origin.mjs', buildDir], {
	cwd: root,
	stdio: ['ignore', 'inherit', 'inherit'],
	env: {
		...process.env,
		NODE_ENV: 'production',
		HOST: '0.0.0.0',
		PORT: String(port),
		DATABASE_URL: previewDbUrl,
		DATA_DIR: dataDir,
		BETTER_AUTH_SECRET: DEMO.secret,
		TMT_MODE: 'selfhost',
		SIGNUP: 'open',
		PUBLIC_URL: '',
		BETTER_AUTH_URL: '',
		ORIGIN: '',
		ADMIN_EMAILS: DEMO.email,
		BODY_SIZE_LIMIT: '1100M',
		KITPACK_DIR: kitDir,
		KITPACK_DOWNLOAD: 'off',
		SHUTDOWN_TIMEOUT: '1'
	}
});

let stopping = false;
async function shutdown(code = 0) {
	if (stopping) return;
	stopping = true;
	say('stopping...');
	server.kill('SIGTERM');
	await new Promise((ok) => {
		if (server.exitCode !== null) return ok();
		server.once('exit', ok);
		setTimeout(() => (server.kill('SIGKILL'), ok()), 5000).unref();
	});
	process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
server.on('exit', (c) => {
	if (!stopping) {
		console.error(`[preview] the server exited (code ${c}).`);
		shutdown(1);
	}
});

for (let i = 0; ; i++) {
	if (i > 120) await shutdown(1).then(() => die('The server did not become healthy in 60 s.'));
	if (stopping) break;
	const ok = await fetch(`${base}/api/health`).then(
		(r) => r.ok,
		() => false
	);
	if (ok) break;
	await new Promise((r) => setTimeout(r, 500));
}
say(`server healthy on port ${port}.`);

// ---- seed (skipped when the demo account already exists)
let seeded;
try {
	seeded = await seedDemo({
		base,
		kitExpected: kit.ok,
		databaseUrl: previewDbUrl,
		catalogLib,
		log: say
	});
} catch (e) {
	console.error(`[preview] seeding failed: ${e.stack ?? e}`);
	await shutdown(1);
}

// ---- summary
const lan = Object.values(networkInterfaces())
	.flat()
	.filter((a) => a && a.family === 'IPv4' && !a.internal)
	.map((a) => a.address)[0];
const lines = [
	'',
	'Preview with sample data (review only, invented data)',
	`  Local:    http://localhost:${port}`,
	`  Network:  ${lan ? `http://${lan}:${port}` : '(no LAN address found)'}   (phone on the same Wi-Fi)`,
	`  Sign in:  ${DEMO.email} / ${DEMO.password}`,
	`  Second member (editor): ${DEMO.editorEmail} / ${DEMO.password}`,
	`  Data:     data/preview/data + database ${previewDbName}${fresh ? ' (fresh)' : ''}`,
	...seeded.summary.map((s) => `  ${s}`),
	kit.ok
		? '  Kit pack: installed (3D chair and plate geometry available)'
		: '  Kit pack: MISSING, no 3D model or plate geometry (see the line above)',
	'',
	'Ctrl+C to stop'
];
console.log(lines.join('\n'));
