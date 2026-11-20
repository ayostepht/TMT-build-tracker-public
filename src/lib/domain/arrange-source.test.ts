import { describe, expect, it } from 'vitest';
import {
	arrange,
	SOLO_MARGIN,
	type ArrangeInput,
	type ArrangePart,
	type ArrangePrinter,
	type ArrangeRole
} from './arrange.ts';
import { arrangeFromSource, soloParts, type SourcePlate } from './arrange-source.ts';
import { pieceBrimMm } from './print-footprint.ts';

// The kit's own layout comes first; the arranger is the exception. Fixture: a "kit" of nine parts on
// five source plates, two of them alone on their plate (big1, big2).

const roles: ArrangeRole[] = [
	{ key: 'primary', name: 'Primary', material: 'PETG' },
	{ key: 'accent', name: 'Accent', material: 'PETG' },
	{ key: 'soft', name: 'Soft', material: 'TPU 95A', tpu: true }
];

const part = (
	slug: string,
	role: string,
	w: number,
	d: number,
	extra: Partial<ArrangePart> = {}
): ArrangePart => ({
	slug,
	name: slug[0].toUpperCase() + slug.slice(1),
	role,
	baseRole: role,
	units: 1,
	grams: 50,
	footprint: { slug, pieces: [{ name: slug, w, d, h: 20, copies: 1 }] },
	...extra
});

const printer = (extra: Partial<ArrangePrinter> = {}): ArrangePrinter => ({
	bedX: 256,
	bedY: 256,
	margin: 1,
	spacing: 8,
	mmSlots: 4,
	...extra
});

const kit = (): ArrangePart[] => [
	part('big1', 'primary', 230, 140),
	part('big2', 'primary', 240, 100),
	part('pa', 'primary', 100, 60),
	part('pb', 'primary', 100, 60),
	part('pc', 'accent', 60, 60),
	part('pd', 'accent', 60, 60),
	part('t1', 'soft', 80, 50),
	part('t2', 'soft', 80, 50),
	part('small', 'accent', 30, 30)
];
const source = (): SourcePlate[] => [
	{ number: 1, name: 'Big One', parts: ['big1'] },
	{ number: 2, name: 'Big Two', parts: ['big2'] },
	{ number: 3, name: 'Pair A B', parts: ['pa', 'pb'] },
	{ number: 4, name: 'Pair C D', parts: ['pc', 'pd'] },
	{ number: 5, name: 'Soft Pair', parts: ['t1', 't2'] },
	{ number: 6, name: 'Small', parts: ['small'] }
];
const input = (parts = kit(), p = printer()): ArrangeInput => ({ parts, roles, printer: p });
const withRole = (parts: ArrangePart[], slug: string, role: string) =>
	parts.map((p) => (p.slug === slug ? { ...p, role } : p));
const plateOf = (r: { plates: { number: number; name: string; parts: string[] }[] }, n: number) =>
	r.plates.find((p) => p.number === n);

describe('A. the source layout stays', () => {
	it('standard palette: every plate is the source plate, same parts, positions and rotations', () => {
		const r = arrangeFromSource(input(), source());
		expect(r.plates.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(r.plates.map((p) => p.parts)).toEqual(source().map((s) => s.parts));
		expect(r.plates.map((p) => p.name)).toEqual(source().map((s) => s.name));
		expect(r.kept).toEqual([1, 2, 3, 4, 5, 6]);
		expect(r.moves).toEqual([]);
		// a source that carries its own positions keeps them exactly
		const withPoses = source().map((s) => ({
			...s,
			items: r.plates.find((p) => p.number === s.number)!.items
		}));
		const again = arrangeFromSource(input(), withPoses);
		expect(again.plates).toEqual(r.plates);
		// and the plain arranger would have merged and re-packed: this is the point
		const plain = arrange(input());
		expect(plain.plates.length).not.toBe(r.plates.length);
	});

	it('a source plate that mixed two kit colors stays mixed while those colors stay', () => {
		const parts = kit().map((p) =>
			p.slug === 'pb' ? { ...p, role: 'accent', baseRole: 'accent' } : p
		);
		const r = arrangeFromSource(input(parts), source());
		expect(plateOf(r, 3)!.parts).toEqual(['pa', 'pb']);
		expect(r.moves).toEqual([]);
		// a printer with a single slot cannot print it: then the minority part leaves
		const one = arrangeFromSource(input(parts, printer({ mmSlots: 1 })), source());
		expect(plateOf(one, 3)!.parts.length).toBe(1);
		expect(one.moves.map((m) => m.slug)).toHaveLength(1);
	});

	it('uses source positions when the plate stays but does not trust ones that leave the bed', () => {
		const r = arrangeFromSource(input(), source());
		const bad = source().map((s) =>
			s.number === 3 ? { ...s, items: r.plates[2].items.map((i) => ({ ...i, x: i.x + 400 })) } : s
		);
		const again = arrangeFromSource(input(), bad);
		expect(plateOf(again, 3)!.parts).toEqual(['pa', 'pb']);
		expect(again.plates[2].items).toEqual(r.plates[2].items);
	});
});

describe('B. only what must move moves', () => {
	it('a design that splits a two-part plate moves only the minority part, to a new plate', () => {
		const standard = arrangeFromSource(input(), source());
		const parts = withRole(kit(), 'pb', 'accent');
		const r = arrangeFromSource(input(parts), source());
		// the same plates in the same places, plus one new plate
		expect(r.plates.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(plateOf(r, 3)!.parts).toEqual(['pa']);
		expect(plateOf(r, 7)!.parts).toEqual(['pb']);
		for (const n of [1, 2, 4, 5, 6]) expect(plateOf(r, n)).toEqual(plateOf(standard, n));
		// the stay part keeps the position it had on the two-part plate
		const was = standard.plates[2].items.find((i) => i.slug === 'pa')!;
		const now = r.plates[2].items.find((i) => i.slug === 'pa')!;
		expect({ x: now.x, y: now.y, rotation: now.rotation }).toEqual({
			x: was.x,
			y: was.y,
			rotation: was.rotation
		});
		expect(r.moves).toEqual([{ slug: 'pb', from: 3, to: 7, reason: 'filament' }]);
		expect(r.kept).toEqual([1, 2, 4, 5, 6]);
	});

	it('the largest same-filament group stays, the minority moves', () => {
		const parts = [
			...kit().filter((p) => !['pa', 'pb'].includes(p.slug)),
			part('x1', 'primary', 70, 50),
			part('x2', 'primary', 70, 50),
			part('x3', 'primary', 70, 50)
		];
		const src = source().map((s) => (s.number === 3 ? { ...s, parts: ['x1', 'x2', 'x3'] } : s));
		const r = arrangeFromSource(input(withRole(parts, 'x2', 'accent')), src);
		expect(plateOf(r, 3)!.parts).toEqual(['x1', 'x3']);
		expect(plateOf(r, 7)!.parts).toEqual(['x2']);
	});

	it('parts the source does not know go to new plates, never onto an existing one', () => {
		const parts = [...kit(), part('extra', 'primary', 30, 30)];
		const r = arrangeFromSource(input(parts), source());
		expect(plateOf(r, 7)!.parts).toEqual(['extra']);
		expect(r.moves).toEqual([{ slug: 'extra', from: null, to: 7, reason: 'new' }]);
		for (let n = 1; n <= 6; n++) expect(plateOf(r, n)!.parts).not.toContain('extra');
	});

	it('a plate that does not fit this bed gives up the part that does not fit, keeping its number', () => {
		const tall = kit().map((p) => (p.slug === 'pb' ? part('pb', 'primary', 200, 200) : p));
		const r = arrangeFromSource(input(tall), source());
		expect(r.plates.filter((p) => p.parts.includes('pa') || p.parts.includes('pb'))).toHaveLength(
			2
		);
		expect(r.moves.map((m) => m.reason)).toEqual(['bed']);
		expect(plateOf(r, 3)).toBeTruthy();
	});

	it('plate numbers and names of untouched plates never change when another plate splits', () => {
		const r = arrangeFromSource(input(withRole(kit(), 'pc', 'primary')), source());
		expect(plateOf(r, 4)!.name).not.toBe('Pair C D'); // lost a part: named for what is on it
		expect(plateOf(r, 3)!.name).toBe('Pair A B');
	});
});

describe('C. single-part plates are sacred', () => {
	it('lists the parts alone on a plate of the source', () => {
		expect(soloParts(source())).toEqual(['big1', 'big2', 'small']);
	});

	it('never receives another part, even with room, even when others are re-arranged', () => {
		const parts = [...withRole(kit(), 'pb', 'accent'), part('extra', 'accent', 20, 20)];
		const r = arrangeFromSource(input(parts), source());
		expect(plateOf(r, 6)!.parts).toEqual(['small']); // 30 x 30 on an otherwise empty bed
		expect(plateOf(r, 1)!.parts).toEqual(['big1']);
		expect(plateOf(r, 2)!.parts).toEqual(['big2']);
		// the movers share their own new plate instead
		expect(plateOf(r, 7)!.parts.sort()).toEqual(['extra', 'pb']);
	});

	it('keeps the relaxed safe area: a part that only fits the bed with a thin edge margin', () => {
		const p = printer({ margin: 5 });
		const parts = [part('big1', 'primary', 250, 120), part('other', 'primary', 40, 40)];
		const r = arrangeFromSource(input(parts, p), [
			{ number: 1, name: 'Big One', parts: ['big1'] },
			{ number: 2, name: 'Other', parts: ['other'] }
		]);
		const big = plateOf(r, 1)!;
		expect(big.parts).toEqual(['big1']);
		const it = r.plates[0].items[0];
		const lo = Math.min(it.x - it.w / 2, it.y - it.d / 2);
		const hi = Math.max(it.x + it.w / 2 - 256, it.y + it.d / 2 - 256);
		expect(lo).toBeGreaterThanOrEqual(SOLO_MARGIN - 0.11);
		expect(lo).toBeLessThan(5); // inside the printer's 5 mm margin
		expect(hi).toBeLessThanOrEqual(-SOLO_MARGIN + 0.11);
		expect(r.warnings.filter((w) => w.code === 'oversize')).toEqual([]);
		// a part that is not alone in the source does not get the relaxed margin
		const shared = arrangeFromSource(input([part('big1', 'primary', 250, 120)], p), [
			{ number: 1, name: 'Big One', parts: ['big1', 'ghost'] }
		]);
		expect(shared.warnings.some((w) => w.code === 'oversize')).toBe(true);
	});

	it('keeps its source pose when the plate stays', () => {
		const r = arrangeFromSource(input(), source());
		const pose = r.plates[0].items.map((i) => ({ ...i, x: i.x + 3, y: i.y - 2 }));
		const src = source().map((s) => (s.number === 1 ? { ...s, items: pose } : s));
		const again = arrangeFromSource(input(withRole(kit(), 'pb', 'accent')), src);
		expect(again.plates[0].items).toEqual(pose);
	});
});

describe('D. brims count', () => {
	const two = (brim: number): ArrangePart[] => [
		part('h1', 'primary', 120, 120, { brims: brim ? [brim] : undefined }),
		part('h2', 'primary', 120, 120, { brims: brim ? [brim] : undefined })
	];
	const run = (parts: ArrangePart[]) => arrange({ parts, roles, printer: printer() });

	it('two parts that fit side by side without their brim are not placed together with it', () => {
		expect(run(two(0)).plates).toHaveLength(1);
		const withBrim = run(two(5));
		expect(withBrim.plates).toHaveLength(2);
		expect(withBrim.plates.every((p) => p.parts.length === 1)).toBe(true);
	});

	it('the brim counts at the bed edge and in the item box', () => {
		const r = run([part('h1', 'primary', 200, 100, { brims: [10] })]);
		const it = r.plates[0].items[0];
		expect(it.w).toBeCloseTo(220, 0);
		expect(it.d).toBeCloseTo(120, 0);
		expect(it.x - it.w / 2).toBeGreaterThanOrEqual(1 - 0.11);
	});

	it('a part that fits only without its brim is placed without it, with a warning', () => {
		const r = run([part('h1', 'primary', 250, 100, { brims: [10] })]);
		expect(r.plates).toHaveLength(1);
		expect(r.plates[0].oversize).toBeUndefined();
		expect(r.warnings.map((w) => w.code)).toEqual(['brim']);
	});

	it('brims of moved parts count; kept source plates are trusted as authored', () => {
		const parts = [
			part('a', 'primary', 120, 120, { brims: [5] }),
			part('b', 'primary', 120, 120, { brims: [5] })
		];
		// the source has both on one plate (the author's file): stays, no brim margin applied
		const kept = arrangeFromSource(input(parts), [{ number: 1, name: 'Both', parts: ['a', 'b'] }]);
		expect(kept.plates).toHaveLength(1);
		expect(kept.kept).toEqual([1]);
		// both leave their plates (new parts): brims count, they cannot share
		const moved = arrangeFromSource(input(parts), []);
		expect(moved.plates).toHaveLength(2);
	});

	it('reads brim width from the object settings, else the part text', () => {
		expect(pieceBrimMm({ settings: { brim_type: 'outer_only', brim_width: '10' } })).toBe(10);
		expect(pieceBrimMm({ settings: { brim_type: 'no_brim', brim_width: '10' } }, '10 mm')).toBe(0);
		expect(pieceBrimMm({ settings: { wall_loops: '2' } }, '10 mm')).toBe(10);
		expect(pieceBrimMm(undefined, null)).toBe(0);
		expect(pieceBrimMm(undefined, 'none')).toBe(0);
		expect(pieceBrimMm({ settings: { brim_type: 'outer_only', brim_width: '900' } })).toBe(20);
	});
});

describe('E. no layout for the bed', () => {
	it('the arranger runs fresh but parts alone in the kit stay alone', () => {
		const solo = soloParts(source());
		const free = arrange(input());
		const guarded = arrange({ ...input(), options: { solo } });
		const together = (r: typeof free, a: string) =>
			r.plates.find((p) => p.parts.includes(a))!.parts.length > 1;
		// without the rule the arranger packs the lone parts with others (or merges them)
		expect(['big1', 'big2', 'small'].some((s) => together(free, s))).toBe(true);
		for (const s of solo) {
			expect(guarded.plates.find((p) => p.parts.includes(s))!.parts).toEqual([s]);
		}
		// everything else is still packed fresh: the pairs share plates
		expect(guarded.plates.some((p) => p.parts.length > 1)).toBe(true);
	});
});
