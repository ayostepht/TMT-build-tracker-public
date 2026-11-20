import { turnstileConfig } from '#lib/server/config.ts';
import type { PageServerLoad } from './$types';

/** Readable signed out. Only whether someone is signed in changes the text (links and back button). */
export const load: PageServerLoad = ({ locals, setHeaders }) => {
	// The text differs for a signed-in visitor: a shared proxy must not serve it to someone else.
	setHeaders({ 'cache-control': 'private, no-cache' });
	return { signedIn: !!locals.user, turnstile: turnstileConfig() !== null };
};
