/**
 * Which paths cookieless analytics may report, and how they are written. Pure and shared by the
 * server (tests, `analytics.ts`) and the browser (`components/Analytics.svelte`).
 */

/** Paths never reported: API calls and invitation links (the id in the URL is a secret). */
export function isAnalyticsExcluded(pathname: string): boolean {
	return /^\/(api|invite)(\/|$)/.test(pathname);
}

/** First path segments whose next segment is an id, slug or token. */
const ID_PARENTS = new Set(['builds', 'teams', 'designs', 'gallery', 'templates', 'invite']);

/**
 * The path as it may be reported: no query or hash, trailing slash dropped, and every segment
 * that follows `builds`, `teams`, `designs`, `gallery` or `templates` replaced by `:id`
 * (`/builds/abc123/plates` becomes `/builds/:id/plates`). Null for paths that are never reported.
 */
export function sanitizeAnalyticsPath(input: string): string | null {
	let pathname = input.split(/[?#]/)[0] || '/';
	if (!pathname.startsWith('/')) pathname = '/' + pathname;
	if (isAnalyticsExcluded(pathname)) return null;
	const out: string[] = [];
	let previous = '';
	for (const segment of pathname.split('/')) {
		if (segment === '') continue;
		const shown = ID_PARENTS.has(previous) ? ':id' : segment;
		out.push(shown);
		previous = shown;
	}
	return '/' + out.join('/');
}

/** Cloudflare's beacon cannot rewrite URLs, so it is only used on pages whose URL carries no id. */
export function cloudflareMayReport(pathname: string): boolean {
	const clean = sanitizeAnalyticsPath(pathname);
	return clean !== null && !clean.includes(':id') && !/[?#]/.test(pathname);
}
