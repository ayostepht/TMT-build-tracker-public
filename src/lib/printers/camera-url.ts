/** Printer camera URL rules shared by server and browser. No Node imports. */
import { cleanHost } from './address.ts';
import { isShareLinkHost } from './share-link.ts';
import type { PrinterKind } from './status.ts';

/** A manual (not connected) printer has no link to fetch from, so no camera. */
export function cameraSupported(kind: PrinterKind): boolean {
	return kind !== 'manual';
}

export type CameraUrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * SSRF guard: only http(s) URLs without credentials whose host equals the printer's OctoEverywhere
 * link host (https, default port). Everything else is refused.
 */
export function checkCameraUrl(raw: string, printerHost: string): CameraUrlCheck {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return { ok: false, error: 'That is not a valid camera address' };
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		return { ok: false, error: 'The camera address must start with https://' };
	if (u.username || u.password)
		return { ok: false, error: 'The camera address must not carry a user name or password' };
	if (cleanHost(u.hostname) !== cleanHost(printerHost))
		return { ok: false, error: 'The camera must be on the same link as the printer' };
	// An OctoEverywhere share-link host is reached over https on the default port only.
	if (isShareLinkHost(cleanHost(printerHost)) && (u.protocol !== 'https:' || u.port))
		return { ok: false, error: 'The camera must use https on the default port' };
	return { ok: true, url: u };
}

/** Resolve a (possibly relative) URL from a printer's own API against its host, then guard it. */
export function resolveCameraUrl(raw: string, base: string, printerHost: string): URL | null {
	try {
		const r = checkCameraUrl(new URL(raw, base).toString(), printerHost);
		return r.ok ? r.url : null;
	} catch {
		return null;
	}
}
