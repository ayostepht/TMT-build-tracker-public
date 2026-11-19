import { isObj } from '#lib/domain/guards.ts';
/**
 * Where a printer's camera is: the printer type's default through the OctoEverywhere link, or what
 * the printer itself reports through it (Moonraker webcam list, OctoPrint settings). Every URL that
 * comes out has passed the SSRF guard: https on the link host only (the connection itself only ever
 * goes to the link's validated public address, see `outbound.ts`).
 */
import { cameraSupported, checkCameraUrl, resolveCameraUrl } from '#lib/printers/camera-url.ts';
import { shareLinkCameraUrl, shareLinkFor, shareLinkUrl } from '#lib/printers/share-link.ts';
import type { PrinterKind } from '#lib/printers/status.ts';
import type { printers } from '../db/schema';
import { assertOutboundAllowed, guardedFetch, isRedirect, readJsonCapped } from './outbound';
import { decryptSecrets } from './secrets';

export type CameraOrigin = 'default' | 'moonraker' | 'octoprint';

export interface CameraSource {
	/** Candidates in order of preference (stream before snapshot); the first that works is used. */
	urls: string[];
	origin: CameraOrigin;
	/** The link host: redirects and every request are held to it. */
	host: string;
	/** Always true: built from an OctoEverywhere link, the only source allowed to reach a share host. */
	shareLink?: boolean;
}

export interface CameraTarget {
	kind: PrinterKind;
	cameraEnabled: boolean;
	secrets: Record<string, string>;
}

export function toCameraTarget(r: typeof printers.$inferSelect): CameraTarget {
	return {
		kind: r.kind as PrinterKind,
		cameraEnabled: r.cameraEnabled,
		secrets: decryptSecrets(r.secretEnc)
	};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Most camera URLs / webcam entries kept from what a remote Moonraker or OctoPrint reports. */
export const MAX_CAMERA_URLS = 4;
/** Longest remote camera URL kept (the same cap as a saved custom address). */
const MAX_CAMERA_URL_LENGTH = 500;

/** GET JSON from the printer's own API; never follows redirects, short timeout. */
async function getJson(
	url: string,
	headers: Record<string, string>,
	fetchFn: typeof fetch,
	timeoutMs: number,
	shareLink = true
): Promise<unknown> {
	const res = await fetchFn(url, {
		headers,
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs),
		...(shareLink ? { allowShareLink: true } : {})
	} as RequestInit);
	if (isRedirect(res.status)) throw new Error('redirect');
	if (!res.ok) throw new Error(`status ${res.status}`);
	return readJsonCapped(res);
}

export interface ResolveOptions {
	fetchFn?: typeof fetch;
	apiTimeoutMs?: number;
}

/** The camera for a printer, or null when it has none (off, unsupported, nothing reported). */
export async function resolveCameraSource(
	t: CameraTarget,
	opts: ResolveOptions = {}
): Promise<CameraSource | null> {
	if (!t.cameraEnabled || !cameraSupported(t.kind)) return null;
	const link = shareLinkFor(t.kind, t.secrets);
	if (!link) return null; // no link: nothing is ever dialled
	assertOutboundAllowed({ allowShareLink: true });
	const fetchFn = opts.fetchFn ?? guardedFetch;
	const timeout = opts.apiTimeoutMs ?? 5000;
	// Every request and redirect is pinned to the link's host: Elegoo's stream is the link's
	// /video; Moonraker's and OctoPrint's come from the printer's own API, and only same-host
	// (relative) URLs survive.
	if (t.kind === 'elegoo-sdcp') {
		const c = checkCameraUrl(shareLinkCameraUrl(link.origin), link.host);
		return c.ok
			? { urls: [c.url.toString()], origin: 'default', host: link.host, shareLink: true }
			: null;
	}
	const listed = await listedCameras(t, link.origin, link.host, fetchFn, timeout);
	return listed ? { ...listed, shareLink: true } : null;
}

/** Moonraker's webcam list / OctoPrint's webcam settings, asked of the printer's API at `api`. */
async function listedCameras(
	t: CameraTarget,
	api: string,
	host: string,
	fetchFn: typeof fetch,
	timeout: number
): Promise<CameraSource | null> {
	const base = `${api}/`;
	const pick = (...cands: unknown[]) =>
		cands
			.map((u) =>
				str(u) && str(u)!.length <= MAX_CAMERA_URL_LENGTH
					? resolveCameraUrl(str(u)!, base, host)
					: null
			)
			.filter((u): u is URL => !!u)
			.map((u) => u.toString())
			.slice(0, MAX_CAMERA_URLS);
	if (t.kind === 'moonraker') {
		const headers: Record<string, string> = {};
		if (t.secrets.apiKey) headers['X-Api-Key'] = t.secrets.apiKey;
		try {
			const j = await getJson(shareLinkUrl(api, '/server/webcams/list'), headers, fetchFn, timeout);
			const cams =
				isObj(j) && isObj(j.result) && Array.isArray(j.result.webcams) ? j.result.webcams : [];
			for (const cam of cams.slice(0, MAX_CAMERA_URLS)) {
				if (!isObj(cam) || cam.enabled === false) continue;
				const urls = pick(cam.stream_url, cam.snapshot_url);
				if (urls.length) return { urls, origin: 'moonraker', host };
			}
		} catch {
			/* no webcam list: no camera */
		}
		return null;
	}
	if (t.kind === 'octoprint') {
		if (!t.secrets.apiKey) return null;
		try {
			const j = await getJson(
				shareLinkUrl(api, '/api/settings'),
				{ 'X-Api-Key': t.secrets.apiKey },
				fetchFn,
				timeout
			);
			const w = isObj(j) && isObj(j.webcam) ? j.webcam : null;
			if (w && w.webcamEnabled !== false) {
				const urls = pick(w.streamUrl, w.snapshotUrl);
				if (urls.length) return { urls, origin: 'octoprint', host };
			}
		} catch {
			/* key lacks settings permission, or old OctoPrint: no camera */
		}
		return null;
	}
	return null;
}
