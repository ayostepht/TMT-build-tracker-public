import { and, eq } from 'drizzle-orm';
import { resolveItem } from '#lib/domain/assembly.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { buildAssembly } from '../db/schema';
import { mutateBuild } from './actions';
import { ASSEMBLY_NOTE_MAX } from './limits';

/**
 * Tick or untick one assembly item, or edit its note. `itemKey` is a step key, `<step>:check:<key>`
 * or `<step>:hw:<name>` of a step that applies to this build's variant choices. Editors and owners only.
 */
export async function setAssemblyItem(
	db: Db,
	buildId: string,
	userId: string,
	itemKey: unknown,
	patch: { done?: unknown; note?: unknown }
): Promise<void> {
	if (typeof itemKey !== 'string' || !itemKey) throw new ApiError(400, 'itemKey is required');
	if (patch.done !== undefined && typeof patch.done !== 'boolean')
		throw new ApiError(400, 'done must be true or false');
	if (
		patch.note !== undefined &&
		(typeof patch.note !== 'string' || patch.note.length > ASSEMBLY_NOTE_MAX)
	)
		throw new ApiError(400, `note must be text of at most ${ASSEMBLY_NOTE_MAX} characters`);
	if (patch.done === undefined && patch.note === undefined)
		throw new ApiError(400, 'Nothing to update');

	await mutateBuild(db, buildId, userId, async (tx, view, now) => {
		const hit = resolveItem(view.assembly.steps, itemKey);
		if (!hit) throw new ApiError(400, 'That item is not part of this build');
		const where = and(eq(buildAssembly.buildId, buildId), eq(buildAssembly.itemKey, itemKey));
		const cur = await first(tx.select().from(buildAssembly).where(where));
		const note = typeof patch.note === 'string' ? patch.note.trim() : undefined;
		const done = patch.done as boolean | undefined;
		const set: Partial<typeof buildAssembly.$inferInsert> = {};
		if (note !== undefined) set.note = note;
		if (done !== undefined) {
			set.done = done;
			set.doneBy = done ? userId : null;
			set.doneAt = done ? now : null;
		}
		if (cur) await tx.update(buildAssembly).set(set).where(where);
		else await tx.insert(buildAssembly).values({ buildId, itemKey, ...set });
		const noteChanged = note !== undefined && note !== (cur?.note ?? '');
		return {
			kind: 'assembly.item',
			payload: {
				itemKey,
				stepKey: hit.step.key,
				step: hit.step.title,
				item: hit.kind,
				text: hit.text,
				...(done !== undefined ? { done } : {}),
				...(noteChanged ? { note: note ? 'set' : 'cleared' } : {})
			}
		};
	});
}
