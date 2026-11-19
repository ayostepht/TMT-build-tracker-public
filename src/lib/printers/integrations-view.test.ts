import { describe, expect, it } from 'vitest';
import { CONNECTION_OPTIONS } from './connection-options.ts';
import {
	chooserGroups,
	connectionLabel,
	hasConnectedPrinter,
	isExperimental,
	optionForPrinter
} from './integrations-view.ts';
import { PRINTER_KINDS } from './status.ts';
import { SETUP_TEXT, guideUrl, PRINTER_GUIDE_URL } from './setup-steps.ts';

describe('chooser groups', () => {
	it('groups in order: OctoEverywhere (1 card, 3 types), Not connected', () => {
		const g = chooserGroups([...CONNECTION_OPTIONS]);
		expect(g.map((x) => x.title)).toEqual(['Through OctoEverywhere', 'Not connected']);
		expect(g[0].entries).toHaveLength(1);
		expect(g[0].entries[0].options.map((o) => o.linkPrinterType)).toEqual([
			'Elegoo',
			'Klipper',
			'OctoPrint'
		]);
		expect(g[1].entries[0].description).toBe('A name only, for logging by hand');
	});

	it("the link's Klipper and OctoPrint types are experimental: the form shows the tag", () => {
		const link = CONNECTION_OPTIONS.filter((o) => o.via === 'link');
		expect(link.map((o) => [o.linkPrinterType, isExperimental(o)])).toEqual([
			['Elegoo', false],
			['Klipper', true],
			['OctoPrint', true]
		]);
		const by = Object.fromEntries(
			chooserGroups([...CONNECTION_OPTIONS])
				.flatMap((x) => x.entries)
				.map((e) => [e.id, e.experimental])
		);
		expect(by).toEqual({ octoeverywhere: false, manual: false });
	});

	it('descriptions are a few words and match what each option supports', () => {
		const g = chooserGroups([...CONNECTION_OPTIONS]);
		const by = Object.fromEntries(g.flatMap((x) => x.entries).map((e) => [e.id, e.description]));
		expect(by).toEqual({
			octoeverywhere: 'For Elegoo, Klipper or OctoPrint, from anywhere',
			manual: 'A name only, for logging by hand'
		});
		for (const e of g.flatMap((x) => x.entries)) {
			expect(e.description.split(/\s+/).length).toBeLessThanOrEqual(8);
		}
	});
});

describe('saved printers', () => {
	const opts = [...CONNECTION_OPTIONS];
	it('finds the option a printer was made from', () => {
		expect(optionForPrinter(opts, { kind: 'moonraker', connection: 'link' })?.key).toBe(
			'octoeverywhere-klipper'
		);
		expect(optionForPrinter(opts, { kind: 'manual', connection: 'manual' })?.key).toBe('manual');
	});
	it('labels the connection and spots connected printers', () => {
		expect(connectionLabel({ kind: 'manual', connection: 'manual' })).toBe('Not connected');
		expect(connectionLabel({ kind: 'octoprint', connection: 'link' })).toBe(
			'OctoPrint · OctoEverywhere link'
		);
		expect(hasConnectedPrinter([{ connection: 'manual' }])).toBe(false);
		expect(hasConnectedPrinter([])).toBe(false);
		expect(hasConnectedPrinter([{ connection: 'manual' }, { connection: 'link' }])).toBe(true);
	});
});

describe('setup text', () => {
	it('every option has a description, 3 to 5 steps and a guide anchor', () => {
		for (const o of CONNECTION_OPTIONS) {
			const t = SETUP_TEXT[o.key];
			expect(t.description.length).toBeGreaterThan(10);
			expect(t.steps.length).toBeGreaterThanOrEqual(3);
			expect(t.steps.length).toBeLessThanOrEqual(5);
			expect(guideUrl(t.anchor)).toBe(`${PRINTER_GUIDE_URL}#${t.anchor}`);
		}
		expect(PRINTER_KINDS.length).toBe(4);
	});
});
