import { listLibrary } from '#lib/server/custom-library.ts';
import { getDb } from '#lib/server/db/index.ts';
import { withReplacedNames } from '#lib/server/library-names.ts';
import type { PageServerLoad } from './$types';

/** The workspace's saved custom parts (members only: `listLibrary` is a 404 for anyone else). */
export const load: PageServerLoad = async ({ parent, locals }) => {
	const { team } = await parent();
	const db = getDb();
	return { pieces: await withReplacedNames(db, await listLibrary(db, team.id, locals.user!.id)) };
};
