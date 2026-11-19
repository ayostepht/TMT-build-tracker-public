/**
 * Thumbnails of color designs drawn on the real chair, for gallery cards that have no saved picture.
 *
 * One shared offscreen `ChairScene` (one WebGL context for the whole page, however many cards)
 * renders the designs one after another. three.js is loaded on the first request, never before;
 * the scene is thrown away a few seconds after the queue empties. Results are kept as object URLs
 * for the session, so paging back and forth does not redraw. Any failure (no WebGL, model missing)
 * resolves to null and the card keeps its color strip.
 */
import type { PartPlacement, TemplateModelInfo } from '#lib/domain/types.ts';
import type { ChairScene } from '#lib/client/three/chair-scene.ts';

const W = 480;
const H = 360;
const IDLE_MS = 6000;

const done = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
let chain: Promise<unknown> = Promise.resolve();

let scene: ChairScene | null = null;
let host: HTMLDivElement | null = null;
let loadedUrl = '';
let idle: ReturnType<typeof setTimeout> | undefined;
let broken = false;

function dispose() {
	scene?.dispose();
	scene = null;
	host?.remove();
	host = null;
	loadedUrl = '';
}

async function ensureScene(model: TemplateModelInfo): Promise<ChairScene | null> {
	if (broken) return null;
	if (!scene) {
		const mod = await import('#lib/client/three/chair-scene.ts');
		if (!mod.webglAvailable()) {
			broken = true;
			return null;
		}
		const libs = await mod.loadLibs();
		host = document.createElement('div');
		host.setAttribute('aria-hidden', 'true');
		host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;pointer-events:none`;
		document.body.append(host);
		const canvas = document.createElement('canvas');
		host.append(canvas);
		scene = new mod.ChairScene(libs, canvas, host, {
			onpick: () => {},
			onready: () => {},
			onprogress: () => {}
		});
	}
	if (loadedUrl !== model.url) {
		loadedUrl = '';
		await scene.loadModel(model.url, null);
		loadedUrl = model.url;
	}
	scene.setPlacements(model.placements as PartPlacement[]);
	return scene;
}

async function render(
	model: TemplateModelInfo,
	partRoles: Record<string, string>,
	roles: { key: string; hex: string }[]
): Promise<string | null> {
	clearTimeout(idle);
	try {
		const s = await ensureScene(model);
		if (!s) return null;
		const hex = Object.fromEntries(roles.map((r) => [r.key, r.hex]));
		s.setColors(
			Object.fromEntries(
				Object.entries(partRoles).flatMap(([slug, role]) => (hex[role] ? [[slug, hex[role]]] : []))
			)
		);
		// let the colors land on the meshes before reading the pixels
		await new Promise((r) => requestAnimationFrame(() => r(null)));
		const blob = await s.snapshot({ width: W, height: H });
		return URL.createObjectURL(blob);
	} catch {
		return null;
	} finally {
		idle = setTimeout(dispose, IDLE_MS);
	}
}

/** The thumbnail of one design as an object URL, or null when it cannot be drawn. */
export function designThumb(
	id: string,
	model: TemplateModelInfo,
	partRoles: Record<string, string>,
	roles: { key: string; hex: string }[]
): Promise<string | null> {
	const key = `${id}:${model.version}:${roles.map((r) => r.key + r.hex).join(',')}`;
	if (done.has(key)) return Promise.resolve(done.get(key) ?? null);
	const have = pending.get(key);
	if (have) return have;
	const job = chain
		.then(() => render(model, partRoles, roles))
		.then((url) => {
			done.set(key, url);
			pending.delete(key);
			return url;
		});
	chain = job.catch(() => null);
	pending.set(key, job);
	return job;
}
