import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The public home is for visitors; someone who is signed in goes straight to their builds. */
export const load: PageServerLoad = ({ locals, setHeaders }) => {
	if (locals.user) redirect(303, '/workspace');
	setHeaders({ 'cache-control': 'private, no-cache' });
};
