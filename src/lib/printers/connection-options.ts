/**
 * The one list the printer setup UI renders from: every way a printer can be added (an
 * OctoEverywhere shared link for Elegoo, Klipper or OctoPrint, or "not connected"), the fields each
 * needs, and whether it has been run against real hardware. Browser-safe, no Node imports.
 */
import type { PrinterKind } from './status.ts';

export type ConnectionKey =
	'octoeverywhere-elegoo' | 'octoeverywhere-klipper' | 'octoeverywhere-octoprint' | 'manual';

/** One input the form shows. `where` says which part of the request body carries it. */
export interface ConnectionField {
	key: string;
	where: 'body' | 'secrets';
	label: string;
	required: boolean;
	/** Write-only: never returned by the API (only listed in `secretsSet`). */
	secret: boolean;
	hint?: string;
}

export interface ConnectionOption {
	key: ConnectionKey;
	label: string;
	/** `kind` to send when creating. */
	kind: PrinterKind;
	via: 'link' | 'manual';
	/** Options sharing a group are shown together (the OctoEverywhere link and its printer types). */
	group: 'octoeverywhere' | 'manual';
	/** For `via: 'link'`: the printer type behind the link, in the maintainer's words. */
	linkPrinterType?: 'Elegoo' | 'Klipper' | 'OctoPrint';
	fields: ConnectionField[];
	/** Has a camera (Not connected has none). */
	camera: boolean;
	/** Run against real hardware by the maintainer (only Elegoo, through a link). */
	verifiedOnHardware: boolean;
}

const name: ConnectionField = {
	key: 'name',
	where: 'body',
	label: 'Name',
	required: true,
	secret: false
};
const link = (): ConnectionField => ({
	key: 'shareLink',
	where: 'secrets',
	label: 'OctoEverywhere shared link',
	required: true,
	secret: true,
	hint: 'Like https://shared-…octoeverywhere.com. Anyone holding the link can reach the printer, so it is stored encrypted and never shown again.'
});
const apiKey = (required: boolean): ConnectionField => ({
	key: 'apiKey',
	where: 'secrets',
	label: required ? 'API key' : 'API key (optional)',
	required,
	secret: true
});
const model: ConnectionField = {
	key: 'catalogId',
	where: 'body',
	label: 'Printer model (optional)',
	required: false,
	secret: false
};

export const CONNECTION_OPTIONS: readonly ConnectionOption[] = [
	{
		key: 'octoeverywhere-elegoo',
		label: 'OctoEverywhere link',
		kind: 'elegoo-sdcp',
		via: 'link',
		group: 'octoeverywhere',
		linkPrinterType: 'Elegoo',
		fields: [name, link(), model],
		camera: true,
		verifiedOnHardware: true
	},
	{
		key: 'octoeverywhere-klipper',
		label: 'OctoEverywhere link',
		kind: 'moonraker',
		via: 'link',
		group: 'octoeverywhere',
		linkPrinterType: 'Klipper',
		fields: [name, link(), apiKey(false), model],
		camera: true,
		verifiedOnHardware: false
	},
	{
		key: 'octoeverywhere-octoprint',
		label: 'OctoEverywhere link',
		kind: 'octoprint',
		via: 'link',
		group: 'octoeverywhere',
		linkPrinterType: 'OctoPrint',
		fields: [name, link(), apiKey(true), model],
		camera: true,
		verifiedOnHardware: false
	},
	{
		key: 'manual',
		label: 'Not connected',
		kind: 'manual',
		via: 'manual',
		group: 'manual',
		fields: [name, model],
		camera: false,
		verifiedOnHardware: false
	}
];

export type ConnectionOptionView = ConnectionOption;
