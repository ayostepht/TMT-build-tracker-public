import { analyticsForRequest } from '#lib/server/analytics.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Tells the browser which cookieless analytics provider to load, if any (see `analytics.ts`).
 * Public values only. Null when analytics is off or the visitor sends DNT / Sec-GPC.
 */
export const load: LayoutServerLoad = ({ request }) => ({
	analytics: analyticsForRequest(request.headers)
});
