/**
 * Cookieless, opt-in page-view analytics.
 *
 * `ANALYTICS_PROVIDER` is `plausible`, `umami` or `cloudflare`; unset (or anything else) means
 * off and nothing is loaded. Only the chosen provider's script is ever injected, and only its
 * exact origins are added to the page CSP (see `security-headers.ts`): never `*`, never
 * `unsafe-inline`. The browser side is `src/lib/components/Analytics.svelte`.
 *
 * Privacy rules enforced here and mirrored in the component:
 *  - page views only, no query string, no hash;
 *  - ids and slugs after `/builds/`, `/teams/`, `/designs/`, `/gallery/` become `:id`;
 *  - `/api/*` and `/invite/*` (the id is a bearer secret) are never reported;
 *  - `DNT: 1` or `Sec-GPC: 1` means nothing is loaded (also checked again in the browser).
 */

export type AnalyticsConfig =
	| { provider: 'plausible'; domain: string; scriptUrl: string }
	| { provider: 'umami'; websiteId: string; scriptUrl: string }
	| { provider: 'cloudflare'; token: string };

export interface CspSources {
	scriptSrc: string[];
	connectSrc: string[];
}

type Env = Record<string, string | undefined>;

export const PLAUSIBLE_DEFAULT_SCRIPT = 'https://plausible.io/js/script.manual.js';
const CLOUDFLARE_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const CLOUDFLARE_CONNECT_ORIGIN = 'https://cloudflareinsights.com';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CF_TOKEN = /^[a-f0-9]{32}$/i;

/** An https URL without credentials, wildcard or fragment; null when it is anything else. */
function httpsUrl(raw: string): URL | null {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
		if (/[*\s]/.test(raw)) return null;
		return url;
	} catch {
		return null;
	}
}

/** The configured provider, or null (off). Misconfiguration also gives null: see `analyticsProblems`. */
export function analyticsConfig(env: Env = process.env): AnalyticsConfig | null {
	const provider = (env.ANALYTICS_PROVIDER ?? '').trim().toLowerCase();
	if (provider === 'plausible') {
		const domain = (env.PLAUSIBLE_DOMAIN ?? '').trim();
		const scriptUrl = (env.PLAUSIBLE_SCRIPT_URL ?? '').trim() || PLAUSIBLE_DEFAULT_SCRIPT;
		if (!DOMAIN.test(domain) || !httpsUrl(scriptUrl)) return null;
		return { provider, domain, scriptUrl };
	}
	if (provider === 'umami') {
		const websiteId = (env.UMAMI_WEBSITE_ID ?? '').trim();
		const scriptUrl = (env.UMAMI_SCRIPT_URL ?? '').trim();
		if (!UUID.test(websiteId) || !httpsUrl(scriptUrl)) return null;
		return { provider, websiteId, scriptUrl };
	}
	if (provider === 'cloudflare') {
		const token = (env.CF_ANALYTICS_TOKEN ?? '').trim();
		if (!CF_TOKEN.test(token)) return null;
		return { provider, token };
	}
	return null;
}

/** Human-readable problems with the analytics settings (logged at start; analytics stays off). Never contains values. */
export function analyticsProblems(env: Env = process.env): string[] {
	const provider = (env.ANALYTICS_PROVIDER ?? '').trim().toLowerCase();
	if (!provider) return [];
	if (!['plausible', 'umami', 'cloudflare'].includes(provider)) {
		return ['ANALYTICS_PROVIDER must be plausible, umami or cloudflare; analytics is off.'];
	}
	if (analyticsConfig(env)) return [];
	if (provider === 'plausible') {
		return [
			'Plausible analytics is off: PLAUSIBLE_DOMAIN must be a host name and PLAUSIBLE_SCRIPT_URL (optional) an https URL.'
		];
	}
	if (provider === 'umami') {
		return [
			'Umami analytics is off: UMAMI_WEBSITE_ID must be a UUID and UMAMI_SCRIPT_URL an https URL.'
		];
	}
	return ['Cloudflare analytics is off: CF_ANALYTICS_TOKEN must be the 32-character beacon token.'];
}

/** Exact origins the chosen provider's script and beacon need. Empty when analytics is off. */
export function analyticsCspSources(config: AnalyticsConfig | null): CspSources {
	if (!config) return { scriptSrc: [], connectSrc: [] };
	if (config.provider === 'cloudflare') {
		return { scriptSrc: [CLOUDFLARE_SCRIPT_ORIGIN], connectSrc: [CLOUDFLARE_CONNECT_ORIGIN] };
	}
	// Plausible and Umami send their events to the host that serves the script.
	const origin = new URL(config.scriptUrl).origin;
	return { scriptSrc: [origin], connectSrc: [origin] };
}

/** Data the root layout hands to the browser: public values only, null when off or the visitor opted out. */
export type AnalyticsClientConfig = AnalyticsConfig;

/** `DNT: 1` or `Sec-GPC: 1` on the request. */
export function doNotTrack(headers: Headers): boolean {
	return headers.get('dnt')?.trim() === '1' || headers.get('sec-gpc')?.trim() === '1';
}

/** What the layout sends to the browser for this request. */
export function analyticsForRequest(
	headers: Headers,
	env: Env = process.env
): AnalyticsClientConfig | null {
	if (doNotTrack(headers)) return null;
	return analyticsConfig(env);
}

export {
	isAnalyticsExcluded,
	sanitizeAnalyticsPath,
	cloudflareMayReport
} from '#lib/analytics-path.ts';
