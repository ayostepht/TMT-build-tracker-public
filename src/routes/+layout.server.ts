import { analyticsForRequest } from '#lib/server/analytics.ts';
import { enabledProviderIds } from '#lib/server/config.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Tells the browser which cookieless analytics provider to load, if any (see `analytics.ts`),
 * and which sign-in providers are enabled so page text names only those. Public values only.
 * Analytics is null when it is off or the visitor sends DNT / Sec-GPC.
 */
export const load: LayoutServerLoad = ({ request }) => ({
	analytics: analyticsForRequest(request.headers),
	signInProviders: enabledProviderIds()
});
