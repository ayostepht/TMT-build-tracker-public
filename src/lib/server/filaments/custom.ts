import { and, asc, eq } from 'drizzle-orm';
import {
	CUSTOM_LIMITS,
	FINISHES,
	customKey,
	type CustomFilament,
	type CustomFilamentInput
} from '#lib/domain/custom-filaments.ts';
import { isHex, normHex } from '#lib/domain/color.ts';
import { ApiError, requireEditor, requireMember } from '../access';
import { advisoryLock, first, one, type DbOrTx } from '../db';
import { customFilaments } from '../db/schema';
import { assertUnder, countCustomFilaments } from '../quota';

/** 409 carrying the id of the filament that already has the same brand, material and color name. */
export class DuplicateFilamentError extends ApiError {
	constructor(public existingId: string) {
		super(409, 'You already have a filament with this brand, type and color name');
	}
}

type Row = typeof customFilaments.$inferSelect;

const toView = (r: Row): CustomFilament => ({
	id: r.id,
	organizationId: r.organizationId,
	brand: r.brand,
	material: r.material,
	colorName: r.colorName,
	hex: r.hex,
	finish: r.finish,
	hardness: r.hardness,
	url: r.url,
	notes: r.notes,
	createdAt: r.createdAt.getTime(),
	updatedAt: r.updatedAt ? r.updatedAt.getTime() : null
});

const text = (v: unknown, field: string, max: number, required: boolean): string => {
	if (v === undefined || v === null || v === '') {
		if (required) throw new ApiError(400, `${field} is required`);
		return '';
	}
	if (typeof v !== 'string') throw new ApiError(400, `${field} must be text`);
	const s = v.trim().replace(/\s+/g, ' ');
	if (!s && required) throw new ApiError(400, `${field} is required`);
	if (s.length > max) throw new ApiError(400, `${field} is too long (max ${max})`);
	return s;
};

/** Validate a request body into a normalized input. With `partial`, absent fields stay undefined. */
export function parseCustomInput(body: unknown): CustomFilamentInput {
	if (!body || typeof body !== 'object') throw new ApiError(400, 'Invalid body');
	const b = body as Record<string, unknown>;
	const hex = typeof b.hex === 'string' ? normHex(b.hex.trim()) : '';
	if (!/^#[0-9a-f]{6}$/i.test(hex) || !isHex(hex))
		throw new ApiError(400, 'Color must be a #rrggbb hex');
	const finish = text(b.finish, 'Finish', CUSTOM_LIMITS.finish, false).toLowerCase();
	if (finish && !(FINISHES as readonly string[]).includes(finish))
		throw new ApiError(400, `Finish must be one of ${FINISHES.join(', ')}`);
	const url = text(b.url, 'Link', CUSTOM_LIMITS.url, false);
	if (url && !/^https?:\/\/[^\s]+$/i.test(url))
		throw new ApiError(400, 'Link must start with http:// or https://');
	return {
		brand: text(b.brand, 'Brand', CUSTOM_LIMITS.brand, true),
		material: text(b.material, 'Type', CUSTOM_LIMITS.material, true),
		colorName: text(b.colorName, 'Color name', CUSTOM_LIMITS.colorName, true),
		hex: hex.toLowerCase(),
		finish: finish || null,
		hardness: text(b.hardness, 'Hardness', CUSTOM_LIMITS.hardness, false) || null,
		url: url || null,
		notes: text(b.notes, 'Notes', CUSTOM_LIMITS.notes, false)
	};
}

async function findDuplicate(
	db: DbOrTx,
	orgId: string,
	input: CustomFilamentInput,
	exceptId?: string
) {
	const key = customKey(input);
	return (
		await db.select().from(customFilaments).where(eq(customFilaments.organizationId, orgId))
	).find((r) => r.id !== exceptId && customKey({ ...r }) === key);
}

/** Any member may read the workspace's filaments (non-members get 404). */
export async function listCustomFilaments(
	db: DbOrTx,
	orgId: string,
	userId: string
): Promise<CustomFilament[]> {
	await requireMember(db, orgId, userId);
	return (
		await db
			.select()
			.from(customFilaments)
			.where(eq(customFilaments.organizationId, orgId))
			.orderBy(asc(customFilaments.brand), asc(customFilaments.colorName))
	).map(toView);
}

export async function createCustomFilament(
	db: DbOrTx,
	orgId: string,
	userId: string,
	body: unknown
): Promise<CustomFilament> {
	await requireEditor(db, orgId, userId);
	const input = parseCustomInput(body);
	// Count and insert in one transaction under a per-workspace lock so parallel requests cannot both pass.
	const row = await db.transaction(async (tx) => {
		await advisoryLock(tx, `quota:custom-filaments:${orgId}`);
		const dup = await findDuplicate(tx, orgId, input);
		if (dup) throw new DuplicateFilamentError(dup.id);
		await assertUnder(tx, 'customFilamentsPerWorkspace', () => countCustomFilaments(tx, orgId), {
			userId,
			scope: orgId
		});
		return one(
			tx
				.insert(customFilaments)
				.values({ organizationId: orgId, ...input, notes: input.notes ?? '', createdBy: userId })
				.returning()
		);
	});
	return toView(row);
}

async function load(db: DbOrTx, id: string, userId: string, edit: boolean): Promise<Row> {
	const row = await first(db.select().from(customFilaments).where(eq(customFilaments.id, id)));
	if (!row) throw new ApiError(404, 'Not found');
	if (edit) await requireEditor(db, row.organizationId, userId);
	else await requireMember(db, row.organizationId, userId);
	return row;
}

export async function updateCustomFilament(
	db: DbOrTx,
	id: string,
	userId: string,
	body: unknown
): Promise<CustomFilament> {
	const row = await load(db, id, userId, true);
	const input = parseCustomInput(body);
	const dup = await findDuplicate(db, row.organizationId, input, id);
	if (dup) throw new DuplicateFilamentError(dup.id);
	const out = await one(
		db
			.update(customFilaments)
			.set({ ...input, notes: input.notes ?? '', updatedAt: new Date() })
			.where(and(eq(customFilaments.id, id)))
			.returning()
	);
	return toView(out);
}

/** Builds that already use the filament keep their own copy of name, color and material. */
export async function deleteCustomFilament(db: DbOrTx, id: string, userId: string): Promise<void> {
	await load(db, id, userId, true);
	await db.delete(customFilaments).where(eq(customFilaments.id, id));
}
