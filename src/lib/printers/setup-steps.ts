/**
 * Maker-facing text for the Integrations page: a one-line description and the short numbered
 * "How to set it up" for every connection option. Browser-safe, no Node
 * imports. The facts come from the form hints, `PRINTER_KIND_INFO`, the adapters and
 * `docs/guides/printers.md`; where a printer's exact menu path is not known the step says what to
 * look for instead of naming a menu.
 */
import type { ConnectionKey } from './connection-options.ts';

/** The printers guide in the public repository (a section is reached with `#<anchor>`). */
export const PRINTER_GUIDE_URL =
	'https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/printers.md';

export interface SetupText {
	/** One line for the option card. */
	description: string;
	/** 3 to 5 short steps. */
	steps: string[];
	/** Section of `docs/guides/printers.md` ("Full guide" link target). */
	anchor: string;
}

const LINK_STEP_COPY =
	'Copy the shared link. It looks like https://shared-…octoeverywhere.com. Anyone who holds it can reach the printer through OctoEverywhere, so keep it private: the app stores it encrypted and never shows it again.';
const LINK_STEP_CREATE =
	'In OctoEverywhere, create a shared connection for the printer (OctoEverywhere explains how in its own help).';
const LINK_STEP_PASTE =
	'Paste the link below. It is all the app needs to reach the printer and its camera.';

export const SETUP_TEXT: Record<ConnectionKey, SetupText> = {
	'octoeverywhere-elegoo': {
		description: 'Live status and camera',
		steps: [
			LINK_STEP_CREATE,
			LINK_STEP_COPY,
			LINK_STEP_PASTE,
			'Press Test connection, then Add printer. Status and the camera both come through the link.'
		],
		anchor: 'through-an-octoeverywhere-shared-link'
	},
	'octoeverywhere-klipper': {
		description: 'Live status and camera',
		steps: [
			LINK_STEP_CREATE,
			LINK_STEP_COPY,
			LINK_STEP_PASTE,
			'Enter Moonraker’s API key only if it requires one.',
			'Press Test connection, then Add printer.'
		],
		anchor: 'klipper-moonraker-through-an-octoeverywhere-shared-link'
	},
	'octoeverywhere-octoprint': {
		description: 'Live status and camera',
		steps: [
			LINK_STEP_CREATE,
			LINK_STEP_COPY,
			LINK_STEP_PASTE,
			'OctoPrint still needs its API key: create an application key in OctoPrint’s settings and paste it below.',
			'Press Test connection, then Add printer.'
		],
		anchor: 'octoprint-through-an-octoeverywhere-shared-link'
	},
	manual: {
		description: 'A name only, for logging by hand',
		steps: [
			'Give the printer a name. You will pick it when you start a plate and when you log a print.',
			'Optionally choose its model.',
			'The app never contacts it: there is no address, no key and no camera.'
		],
		anchor: 'a-printer-that-is-not-connected'
	}
};

/** The OctoEverywhere row (three printer types behind one row). */
export const LINK_GROUP_DESCRIPTION = 'For Elegoo, Klipper or OctoPrint, from anywhere';

/** The printer connection report form: where makers report how an experimental option went. */
export const ISSUES_URL =
	'https://github.com/ayostepht/TMT-Build-Tracker/issues/new?template=printer-report.yml';

export const guideUrl = (anchor: string) => `${PRINTER_GUIDE_URL}#${anchor}`;
