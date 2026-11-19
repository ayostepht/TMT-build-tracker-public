import { ApiError, requireMember, requireOwner } from '#lib/server/access.ts';
import { readJson, requireUserId, respond } from '#lib/server/api.ts';
import { getDb } from '#lib/server/db/index.ts';
import { getOrgSettings, setOrgSettings } from '#lib/server/org-settings.ts';
import type { RequestHandler } from './$types';

/** Workspace printer settings: log finished prints automatically. Members read, owners change. */
export const GET: RequestHandler = (event) =>
	respond(() => {
		const db = getDb();
		const org = event.url.searchParams.get('org');
		if (!org) throw new ApiError(400, 'org is required');
		const role = requireMember(db, org, requireUserId(event));
		return { settings: getOrgSettings(db, org), canEdit: role === 'owner' };
	});

export const PUT: RequestHandler = (event) =>
	respond(async () => {
		const db = getDb();
		const userId = requireUserId(event);
		const body = (await readJson(event)) as Record<string, unknown>;
		const org = typeof body?.organizationId === 'string' ? body.organizationId : '';
		if (!org) throw new ApiError(400, 'organizationId is required');
		requireOwner(db, org, userId);
		const patch: Parameters<typeof setOrgSettings>[2] = {};
		if (body.autoLogPrints !== undefined) {
			if (typeof body.autoLogPrints !== 'boolean')
				throw new ApiError(400, 'autoLogPrints must be true or false');
			patch.autoLogPrints = body.autoLogPrints;
		}
		setOrgSettings(db, org, patch);
		return { settings: getOrgSettings(db, org) };
	});
