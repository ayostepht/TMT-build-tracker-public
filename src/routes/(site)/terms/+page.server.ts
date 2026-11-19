import type { PageServerLoad } from './$types';

/** Readable signed out. Only whether someone is signed in changes the text (the back button). */
export const load: PageServerLoad = ({ locals, setHeaders }) => {
	// The page differs for a signed-in visitor: a shared proxy must not serve it to someone else.
	setHeaders({ 'cache-control': 'private, no-cache' });
	return { signedIn: !!locals.user };
};
