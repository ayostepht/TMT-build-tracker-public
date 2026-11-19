import { redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { listGallery } from '#lib/server/designs/gallery.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// The (app) layout already guards the route; this keeps the type honest and never lists to a visitor.
	if (!locals.user) redirect(303, '/login?redirect=%2Fgallery');
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const family = url.searchParams.get('family') ?? '';
	const gallery = await listGallery(getDb(), locals.user.id, {
		q,
		family,
		page: Number(url.searchParams.get('page')) || 1
	});
	return { gallery, q, family };
};
