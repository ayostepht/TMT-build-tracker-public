/**
 * Server side of the plate arranger: turns a `BuildView` plus the template's print
 * footprints into `arrange()` input, and writes the result as the build's plates
 * (`source = 'arranged'`, positions in `build_plates.arrangement`).
 *
 * Kept free of `mutateBuild` so it can be called from inside it (automatic
 * re-arrange after a color / variant / printer change).
 */
import { and, eq } from 'drizzle-orm';
import {
	arrange,
	type ArrangeOptions,
	type ArrangeInput,
	type ArrangePart,
	type ArrangeResult,
	type ArrangeRole,
	type ArrangedPlate
} from '#lib/domain/arrange.ts';
import type { PrintFootprint } from '#lib/domain/print-footprint.ts';
import type { LearnedTime } from '#lib/domain/time-estimate.ts';
import type { BuildView } from '#lib/domain/types.ts';
import { effectiveKeepOut } from '#lib/printers/printer.ts';
import { first, type DbOrTx } from '../db';
import { buildPlates, builds, templatePlateLayouts, templatePrintGeometry } from '../db/schema';
import { gramsSourceOf, loadBuildView } from './view';
import { estimateArrangedPlates, loadTimeModel } from './time-model';
import { ensureSilhouettes } from '../print-geometry/store';

export const ARRANGED_LAYOUT = 'arranged';
export const ARRANGED_SOURCE = 'arranged';

/** Edge margin stored by builds planned before the default became 1 mm; read as the new default. */
export const OLD_DEFAULT_MARGIN = 5;
export const NEW_DEFAULT_MARGIN = 1;
export const effectiveMargin = (m: number) => (m === OLD_DEFAULT_MARGIN ? NEW_DEFAULT_MARGIN : m);

const TEMPLATE_ROLE_NAMES = /^[a-z]+$/;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Print footprints stored for a template, by slug (seed rows and imported rows alike). */
export async function loadFootprints(
	db: DbOrTx,
	templateId: string
): Promise<Map<string, PrintFootprint>> {
	await ensureSilhouettes(db, templateId);
	const out = new Map<string, PrintFootprint>();
	for (const r of await db
		.select()
		.from(templatePrintGeometry)
		.where(eq(templatePrintGeometry.templateId, templateId))) {
		const fp = r.footprint as unknown as PrintFootprint;
		if (fp?.pieces?.length) out.set(r.slug, { ...fp, slug: r.slug });
	}
	return out;
}

export interface Plan {
	result: ArrangeResult;
	/** Slugs without a footprint. */
	unsized: string[];
	/** The build's print template, as time model input (per-part seconds and grams from the user's slice). */
	learned?: Map<string, LearnedTime>;
}

/** Learned per-part data of a build view as time model input. */
export function learnedOf(view: BuildView): Map<string, LearnedTime> {
	return new Map(
		Object.entries(view.partProfiles ?? {}).map(([slug, pr]) => [
			slug,
			{ secondsPerCopy: pr.secondsPerCopy, gramsByRole: pr.gramsByRole, copies: pr.copies }
		])
	);
}

/** Role labels for plate names: the kit's own slots by key ("Accent"), added colors by name. */
function roleLabel(f: BuildView['filaments'][number]): string {
	return TEMPLATE_ROLE_NAMES.test(f.key) && f.key.length <= 12 ? cap(f.key) : f.name;
}

/** `arrange()` input for a build view: its parts, filament roles and printer. Null without a printer. */
function arrangeInputFor(
	view: BuildView,
	footprints: Map<string, PrintFootprint>,
	layoutHint: string | null,
	options?: ArrangeOptions
): ArrangeInput | null {
	const p = view.printer;
	if (!p) return null;
	const roles: ArrangeRole[] = view.filaments.map((f) => ({
		key: f.key,
		name: roleLabel(f),
		material: f.material,
		tpu: f.tpu
	}));
	const parts: ArrangePart[] = [];
	const unsized: { slug: string; name: string; role: string; grams: number | null }[] = [];
	for (const part of view.parts) {
		const units = Math.max(1, part.qty ?? 1);
		const learnedGrams = Object.values(view.partProfiles?.[part.slug]?.gramsByRole ?? {}).reduce(
			(a, b) => a + b,
			0
		);
		const grams =
			learnedGrams > 0
				? Math.round(learnedGrams * 10) / 10
				: part.bomGrams != null
					? Math.round((part.bomGrams / units) * 10) / 10
					: null;
		const fp = footprints.get(part.slug);
		if (!fp) {
			unsized.push({ slug: part.slug, name: part.name, role: part.role, grams: part.bomGrams });
			continue;
		}
		const bits: string[] = [];
		if (part.variantGroup) {
			const g = view.variantGroups.find((x) => x.key === part.variantGroup);
			const others = g?.options.filter((o) => o.key !== part.variantOption) ?? [];
			if (g && others.length)
				bits.push(
					`Try the ${others.map((o) => `"${o.name}"`).join(' or ')} option for ${g.name} (Settings, Options).`
				);
		}
		if (layoutHint) bits.push(layoutHint);
		parts.push({
			slug: part.slug,
			name: part.name,
			role: part.role,
			footprint: fp,
			units,
			grams,
			group: part.symmetryGroup ? `sym:${part.symmetryGroup}` : null,
			hint: bits.join(' ') || null
		});
	}
	return {
		parts,
		unsized,
		roles,
		printer: {
			bedX: p.bedX,
			bedY: p.bedY,
			bedZ: p.bedZ,
			margin: effectiveMargin(p.margin),
			spacing: p.spacing,
			keepOut: effectiveKeepOut(p),
			mmSlots: p.mmSlots
		},
		// TMT_ARRANGE_OPTIMIZE=off: diagnostic switch to compare with the packer-only layout (screenshots, bug reports)
		options:
			options ?? (process.env.TMT_ARRANGE_OPTIMIZE === 'off' ? { optimize: false } : undefined)
	};
}

export function planArrangement(
	view: BuildView,
	footprints: Map<string, PrintFootprint>,
	layoutHint: string | null = null,
	options?: ArrangeOptions
): Plan | null {
	const input = arrangeInputFor(view, footprints, layoutHint, options);
	if (!input) return null;
	return {
		result: arrange(input),
		unsized: (input.unsized ?? []).map((u) => u.slug),
		learned: learnedOf(view)
	};
}

export interface LayoutPlacement {
	/** The build's plates (same numbers, names, runs and parts as the Print tab), with positions. */
	plates: ArrangedPlate[];
	/** Plates whose parts needed more than one bed here: the number, name and how many extra plates were added. */
	overflow: { number: number; name: string; extra: number }[];
}

/**
 * Place the parts of each of the build's existing plates (a MakeGood layout carries membership
 * only, no positions) flat on the bed, one plate at a time: the plate numbers, names, runs and
 * part grouping stay exactly as on the Print tab. Only flat Z rotations (see `arrange.ts`). A
 * plate whose parts do not fit one bed (other bed keep-outs, a recolor, parts bigger than the
 * bed) keeps its own number for the first bed; the rest goes to extra plates numbered after the
 * last, listed in `overflow`. Null without a printer.
 */
export function placeOnPlates(
	view: BuildView,
	footprints: Map<string, PrintFootprint>,
	layoutHint: string | null = null
): LayoutPlacement | null {
	const input = arrangeInputFor(view, footprints, layoutHint);
	if (!input) return null;
	const bySlug = new Map(input.parts.map((p) => [p.slug, p]));
	const out: ArrangedPlate[] = [];
	const extras: { from: ArrangedPlate; src: number }[] = [];
	const overflow: LayoutPlacement['overflow'] = [];
	const roleOf = new Map(view.parts.map((p) => [p.slug, p.role]));
	for (const pl of view.plates) {
		const parts = pl.parts.map((s) => bySlug.get(s)).filter((p) => !!p);
		if (!parts.length) {
			// no part of this plate has a footprint: keep the plate so the export names the missing geometry
			out.push({
				number: pl.number,
				name: pl.name,
				items: [],
				parts: pl.parts,
				roles: [...new Set(pl.parts.map((s) => roleOf.get(s)).filter((r): r is string => !!r))],
				runs: pl.runs,
				estGrams: {},
				utilisation: 0,
				bed: { x: input.printer.bedX, y: input.printer.bedY, margin: input.printer.margin }
			});
			continue;
		}
		const r = arrange({ ...input, parts, unsized: [] });
		const [first, ...rest] = r.plates;
		if (!first) continue;
		out.push({ ...first, number: pl.number, name: pl.name, runs: pl.runs });
		if (rest.length) overflow.push({ number: pl.number, name: pl.name, extra: rest.length });
		for (const x of rest) extras.push({ from: x, src: pl.number });
	}
	let next = Math.max(0, ...view.plates.map((p) => p.number)) + 1;
	for (const { from, src } of extras) {
		const base = view.plates.find((p) => p.number === src)!;
		out.push({ ...from, number: next++, name: `${base.name} (continued)`, runs: base.runs });
	}
	return { plates: out.sort((a, b) => a.number - b.number), overflow };
}

/** Stable identity of a plate set: what is on each plate in which color, no positions. */
export function signature(plates: Pick<ArrangedPlate, 'parts' | 'roles' | 'runs'>[]): string {
	return plates
		.map((pl) => `${[...pl.parts].sort().join(',')}|${[...pl.roles].sort().join(',')}|${pl.runs}`)
		.sort()
		.join(';');
}

/** The build's plate-attached print logs (they would be orphaned by replacing plates). */
export const hasPlateRuns = (view: BuildView) => view.runs.some((r) => r.plateNumber != null);

/** What survives a plate replacement: typed time and typed grams (see `manualTimes`). */
export interface PlateManuals {
	manualEstSeconds: number | null;
	manualEstSource: 'user' | 'printer' | null;
	/** Typed plate grams; only present when the old plate's grams were typed by hand. */
	typedGrams?: {
		slicerGrams: number | null;
		slicerByPart: Record<string, number>;
		slicerGramsSource: 'user';
	};
}

/**
 * Manual plate times and typed plate grams keyed for carrying over when plates are replaced: a new
 * plate keeps the old plate's manual time (and typed grams, source 'user') only when it has the same
 * number and the same set of parts. Grams that came from a file or a printer job are not carried:
 * the new plates have their own source.
 */
export async function manualTimes(
	tx: DbOrTx,
	buildId: string
): Promise<(number: number, parts: string[]) => PlateManuals> {
	const old = await tx.select().from(buildPlates).where(eq(buildPlates.buildId, buildId));
	const key = (n: number, parts: string[]) => `${n}:${[...parts].sort().join(',')}`;
	const m = new Map<string, PlateManuals>();
	for (const o of old) {
		const typed =
			gramsSourceOf(o, undefined, false) === 'user' &&
			((o.slicerGrams ?? 0) > 0 || Object.values(o.slicerByPart).some((v) => v > 0));
		if (!o.manualEstSeconds && !typed) continue;
		m.set(key(o.number, o.parts), {
			manualEstSeconds: o.manualEstSeconds ?? null,
			manualEstSource: o.manualEstSeconds ? (o.manualEstSource ?? 'user') : null,
			typedGrams: typed
				? {
						slicerGrams: o.slicerGrams,
						slicerByPart: o.slicerByPart,
						slicerGramsSource: 'user'
					}
				: undefined
		});
	}
	return (number, parts) =>
		m.get(key(number, parts)) ?? { manualEstSeconds: null, manualEstSource: null };
}

/** Column values to spread into an insert: the carried time, and typed grams when there are any. */
export function carryManuals(h: PlateManuals) {
	const { typedGrams, ...time } = h;
	return { ...time, ...(typedGrams ?? {}) };
}

/** Replace the build's plates with a plan. Callers must have dealt with plate-attached runs. */
export async function writePlan(tx: DbOrTx, buildId: string, plan: Plan): Promise<number> {
	const tplId = (
		await first(tx.select({ t: builds.templateId }).from(builds).where(eq(builds.id, buildId)))
	)?.t;
	// MakeGood's X/P/A times, spread over the plate's items (an estimate; the view recomputes it too)
	const est = tplId
		? estimateArrangedPlates(
				await loadTimeModel(tx, tplId, plan.learned),
				plan.result.plates.map((pl) => ({
					number: pl.number,
					runs: pl.runs,
					arrangement: pl,
					parts: pl.parts
				}))
			)
		: null;
	const manualFor = await manualTimes(tx, buildId);
	await tx.delete(buildPlates).where(eq(buildPlates.buildId, buildId));
	for (const pl of plan.result.plates)
		await tx.insert(buildPlates).values({
			buildId,
			number: pl.number,
			name: pl.name,
			estSeconds: est?.get(pl.number)?.estSeconds ?? null,
			runs: pl.runs,
			perPartRuns: false,
			parts: pl.parts,
			...carryManuals(manualFor(pl.number, pl.parts)),
			source: ARRANGED_SOURCE,
			arrangement: pl
		});
	await tx.update(builds).set({ plateLayout: ARRANGED_LAYOUT }).where(eq(builds.id, buildId));
	return plan.result.plates.length;
}

/**
 * After a change that moves parts between colors or switches variants or printer:
 * if the build's plates are arranged and no print log hangs on a plate, arrange again.
 * Returns whether plates were rewritten. With plate logs, or once the build has started
 * (`view.started`: any run, part not To print, Printing part or live printer job) it does nothing
 * (the UI offers "re-arrange" and asks first).
 */
export async function autoRearrange(
	tx: DbOrTx,
	buildId: string,
	view: BuildView,
	footprints: Map<string, PrintFootprint>,
	layoutHint: string | null
): Promise<boolean> {
	const b = await first(
		tx
			.select({ layout: builds.plateLayout })
			.from(builds)
			.where(and(eq(builds.id, buildId)))
	);
	if (b?.layout !== ARRANGED_LAYOUT || hasPlateRuns(view)) return false;
	// A build that has started printing keeps its plates: rewriting them renumbers plates under a
	// live printer job and under Printing parts. The plates go stale instead (banner offers a
	// deliberate "Re-arrange"). Issue #56.
	if (view.started.started) return false;
	const plan = planArrangement(view, footprints, layoutHint);
	if (!plan) return false;
	await writePlan(tx, buildId, plan);
	return true;
}

/** Activity kinds after which arranged plates are re-arranged by `mutateBuild`. */
export const REARRANGE_KINDS = new Set([
	'design.update',
	'design.apply',
	'build.variant',
	'build.printer'
]);

/** Advice appended to oversize warnings when the kit has other (printer-specific) layouts. */
export async function layoutHintFor(db: DbOrTx, templateId: string): Promise<string | null> {
	const layouts = await db
		.select({ name: templatePlateLayouts.name, isDefault: templatePlateLayouts.isDefault })
		.from(templatePlateLayouts)
		.where(eq(templatePlateLayouts.templateId, templateId));
	if (layouts.length < 2) return null;
	return 'The MakeGood layouts in the picker may print it in another orientation.';
}

/** `autoRearrange` with its inputs loaded; used by `mutateBuild` right after a mutation. */
export async function autoRearrangeBuild(
	tx: DbOrTx,
	buildId: string,
	userId: string
): Promise<boolean> {
	const view = await loadBuildView(tx, buildId, userId);
	if (!view) return false;
	return autoRearrange(
		tx,
		buildId,
		view,
		await loadFootprints(tx, view.build.templateId),
		await layoutHintFor(tx, view.build.templateId)
	);
}
