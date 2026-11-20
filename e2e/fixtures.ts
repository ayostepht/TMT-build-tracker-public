import {
	test as base,
	type APIRequestContext,
	type Browser,
	type BrowserContext
} from '@playwright/test';

export { expect } from '@playwright/test';

let n = 0;
/**
 * Better Auth rate-limits sign-up / sign-in per client IP (3 per 10 s). The test server
 * is configured as if behind one trusted proxy (playwright.config.ts), which makes the
 * server take the client address from X-Forwarded-For, so give each context its own,
 * like separate clients behind a proxy would have.
 */
export function clientIp(): string {
	n += 1;
	return `10.${(Date.now() >> 8) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export async function newClientContext(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp() } });
}

const RETRY_PATCHED = Symbol.for('tmt.e2e.getRetry');

/**
 * Why GETs retry (the ECONNRESET flake, measured 2026-11-20): Playwright's API request client
 * keeps sockets alive and does not drop one when the server's
 * `Keep-Alive: timeout=5` hint says to. Node's HTTP server closes an idle socket after
 * keepAliveTimeout + 1 s = 6.0 s. A request sent on that socket in the same instant as the
 * server's FIN gets ECONNRESET: the server never read it. The window is a few ms on an idle
 * machine (1 in ~180 in a standalone probe with idle times drawn from 5.95 to 6.05 s) and
 * grows when the Playwright driver or the server is starved of CPU by another suite or a build,
 * which is when it showed up (always after a pause of about 6 s between two API calls of one
 * test, for instance a UI wait between `page.request.get`s). The app is not at fault.
 * Playwright can retry ECONNRESET itself (`maxRetries`, off by default): turn it on for
 * GET and HEAD, which have no side effects, on every API request context. Writes are not
 * retried: a reset there would hide a real server problem.
 */
function retryResetsOnReads(api: APIRequestContext): void {
	const proto = Object.getPrototypeOf(api) as {
		fetch: (
			this: APIRequestContext,
			target: unknown,
			options?: { method?: string; maxRetries?: number }
		) => Promise<unknown>;
		[RETRY_PATCHED]?: boolean;
	};
	if (proto[RETRY_PATCHED]) return;
	const original = proto.fetch;
	proto.fetch = function (this: APIRequestContext, target, options = {}) {
		const method = (
			options.method ??
			(typeof target === 'object' && target !== null && 'method' in target
				? (target as { method(): string }).method()
				: 'GET')
		).toUpperCase();
		const isRead = method === 'GET' || method === 'HEAD';
		return original.call(this, target, isRead ? { maxRetries: 3, ...options } : options);
	};
	proto[RETRY_PATCHED] = true;
}

export const test = base.extend<object, { getRetryOnReset: void }>({
	// Worker-scoped and automatic: patches the API request client once, for every spec that
	// imports `test` from here (page.request, context.request and the `request` fixture alike).
	getRetryOnReset: [
		async ({ playwright }, use) => {
			const probe = await playwright.request.newContext();
			retryResetsOnReads(probe);
			await probe.dispose();
			await use();
		},
		{ scope: 'worker', auto: true }
	],
	// Applies to the browser context (page) and to the `request` fixture alike: the server
	// runs behind a "trusted proxy" (ADDRESS_HEADER=x-forwarded-for), so every request to
	// /api/auth/* must carry exactly one X-Forwarded-For or it is rejected with 400.
	// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructured first argument
	extraHTTPHeaders: async ({}, use) => {
		await use({ 'x-forwarded-for': clientIp() });
	}
});
