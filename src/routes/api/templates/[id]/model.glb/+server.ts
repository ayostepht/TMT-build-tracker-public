import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { first } from '#lib/server/db/index.ts';
import { templates } from '#lib/server/db/schema.ts';
import { getDb } from '#lib/server/db/index.ts';
import { canViewTemplate } from '#lib/server/templates/fork.ts';
import { gzipFile } from '#lib/server/compress.ts';
import { templateModelPath } from '#lib/server/config.ts';
import type { RequestHandler } from './$types';

/**
 * Streams the template's assembled model (`<dataDir>/uploads/models/<templateId>.glb`).
 * Signed-in users, plus signed-out visitors for the built-in kit only (a template without an
 * owner workspace: the public home page shows the MakeGood chair). A workspace's kit copy needs
 * sign-in and membership. The URL carries `?v=<version>`, so it is cached for a year.
 */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	// The id is a UUID; refuse anything that could walk the path.
	if (!/^[A-Za-z0-9_-]+$/.test(params.id)) error(404, 'Not found');
	const tpl = await first(
		getDb()
			.select({ owner: templates.ownerOrgId })
			.from(templates)
			.where(eq(templates.id, params.id))
	);
	if (locals.user) {
		// Another workspace's kit copy is not readable (404, same as a missing file).
		if (!(await canViewTemplate(getDb(), locals.user, params.id))) error(404, 'Not found');
	} else if (!tpl || tpl.owner) error(401, 'Sign in required');
	// The built-in kit is the same for everyone and the URL carries its version, so it may be
	// cached publicly; a workspace's kit copy stays private to the browser.
	const cacheControl = `${tpl && !tpl.owner ? 'public' : 'private'}, max-age=31536000, immutable`;
	const path = templateModelPath(params.id);
	let size: number;
	let mtimeMs: number;
	try {
		const s = await stat(path);
		if (!s.isFile()) error(404, 'Not found');
		size = s.size;
		mtimeMs = s.mtimeMs;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(404, 'Not found');
	}
	const zipped = await gzipFile(request, path, size, mtimeMs, () => readFile(path));
	if (zipped)
		return new Response(new Uint8Array(zipped), {
			headers: {
				'content-type': 'model/gltf-binary',
				'content-encoding': 'gzip',
				'content-length': String(zipped.length),
				'x-file-size': String(size),
				vary: 'Accept-Encoding',
				'cache-control': cacheControl
			}
		});
	return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
		headers: {
			'content-type': 'model/gltf-binary',
			'content-length': String(size),
			'cache-control': cacheControl
		}
	});
};
