import { publicUrl } from '#lib/server/config.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => ({
	signedIn: !!locals.user,
	isDemo: (locals.user as { isDemo?: boolean } | null)?.isDemo === true,
	/** Absolute links in link-preview tags: the configured public origin, else this request's. */
	siteOrigin: publicUrl() ?? url.origin
});
