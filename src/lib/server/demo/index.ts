import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import type { Auth } from '../auth';
import { demoConfig } from '../config';
import { DemoBusyError } from './plugin';
import { takeDemoStart } from './limits';

export { DemoBusyError } from './plugin';
export { cleanupExpiredDemos, deleteDemoUser, liveDemoCount, startDemoCleanup } from './cleanup';
export { resetDemoLimits } from './limits';
export { seedDemoBuild } from './seed';

/** The per-IP limit was reached; `retryAfter` is in seconds. */
export class DemoRateError extends Error {
	constructor(public retryAfter: number) {
		super('Too many demos from this address. Try again later.');
	}
}

/** The cookie jar SvelteKit gives a request event (`event.cookies`). */
export interface CookieJar {
	set(name: string, value: string, opts: Record<string, unknown>): void;
}

/**
 * Start a demo for `ip`: per-IP limit, then the server-only endpoint (live cap, user, sample
 * build, session). Copies the session cookie onto `cookies`. Throws `DemoRateError` or
 * `DemoBusyError`; returns the id of the sample build.
 */
export async function startDemo(auth: Auth, ip: string, cookies: CookieJar): Promise<string> {
	const cfg = demoConfig();
	const wait = takeDemoStart(ip, cfg.perIpPerHour);
	if (wait > 0) throw new DemoRateError(wait);
	let res;
	try {
		res = await auth.api.startDemo({ headers: new Headers(), returnHeaders: true });
	} catch (e) {
		// Better Auth wraps thrown errors; ours carry the original as `cause` or are rethrown as is.
		if (e instanceof DemoBusyError || (e as { cause?: unknown }).cause instanceof DemoBusyError)
			throw new DemoBusyError();
		throw e;
	}
	const raw = res.headers.get('set-cookie');
	if (raw)
		for (const [name, attrs] of parseSetCookieHeader(raw))
			cookies.set(name, attrs.value, { ...toCookieOptions(attrs), path: attrs.path || '/' });
	return (res.response as { buildId: string }).buildId;
}
