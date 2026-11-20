import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** One-time notices carried to the page we land on (fixed codes only, never text from the URL). */
const NOTICES = new Set(['left', 'deleted']);

export const load: PageServerLoad = async ({ parent, url }) => {
	const { teams, activeTeamId } = await parent();
	const team = teams.find((t) => t.id === activeTeamId);
	const notice = url.searchParams.get('notice');
	const q = notice && NOTICES.has(notice) ? `?notice=${notice}` : '';
	redirect(303, team ? `/teams/${team.slug}${q}` : `/onboarding${q}`);
};
