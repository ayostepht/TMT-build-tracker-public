import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	signedIn: !!locals.user,
	isDemo: (locals.user as { isDemo?: boolean } | null)?.isDemo === true
});
