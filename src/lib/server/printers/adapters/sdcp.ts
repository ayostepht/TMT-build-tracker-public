import { isObj, type Obj } from '#lib/domain/guards.ts';
/**
 * Elegoo SDCP (Smart Device Control Protocol v3) over WebSocket, through an OctoEverywhere shared
 * link only, and strictly read-only. Every request is built by `sdcpEnvelope`, which refuses any
 * command that is not a read (`SDCP_READ_COMMANDS`); there is no write command at all.
 *
 * Centauri Carbon (CC1): `wss://<link host>/websocket`, JSON envelopes
 * `{ Id, Topic: 'sdcp/request/<MainboardID>', Data: { Cmd, Data, RequestID, MainboardID, TimeStamp, From } }`.
 * Through the link we send only Cmd 1 (attributes refresh), once; answers arrive on
 * `sdcp/status/<id>` and `sdcp/attributes/<id>`. Sources: Elegoo's SDCP v3 spec
 * (cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0), OpenCentauri, pycentauri docs and the
 * danielcherubini/elegoo-homeassistant integration. The FDM print-status codes are the
 * Centauri ones (13 printing, 9 complete, 8 stopped...). CC1 allows ~5 concurrent sockets.
 */
import { randomBytes } from 'node:crypto';
import type { PrinterFilament, PrinterStatus } from '#lib/printers/status.ts';
import { shareLinkOf, shareLinkSocketUrl } from '#lib/printers/share-link.ts';
import { MAX_REMOTE_MESSAGE_BYTES, resolveAllowed, safeFileName } from '../outbound';
import {
	CONNECT_TIMEOUT_MS,
	FLOODED_MESSAGE,
	HostileGuard,
	linkBackoff,
	LINK_SILENT_CLOSE_MS,
	MessageBudget,
	num,
	OVERSIZED_MESSAGE,
	safeError,
	StatusSubject,
	temp,
	type AdapterHandle,
	type PrinterConfig
} from '../types';
import { openSocket, type SocketLike, type SocketPin } from '../ws-client';

/** Read-only commands: status refresh and attributes refresh. Always sent with empty data. */
export const SDCP_READ_COMMANDS: readonly number[] = [0, 1];
/**
 * Write commands this app may send: none. The app only observes; never add anything that turns
 * something on or moves, heats, pauses, stops or starts a print.
 */
export const SDCP_ALLOWED_COMMANDS: readonly number[] = [];

export class SdcpCommandError extends Error {}

/** The one place an SDCP request is built: throws unless the command is a read with no data. */
export function sdcpEnvelope(cmd: number, data: Obj, mainboardId: string): string {
	if (!SDCP_READ_COMMANDS.includes(cmd))
		throw new SdcpCommandError(`SDCP command ${cmd} is not allowed`);
	if (JSON.stringify(data) !== '{}')
		throw new SdcpCommandError(`SDCP command ${cmd} takes no data`);
	return JSON.stringify({
		Id: mainboardId,
		Topic: `sdcp/request/${mainboardId}`,
		Data: {
			Cmd: cmd,
			Data: data,
			RequestID: randomBytes(8).toString('hex'),
			MainboardID: mainboardId,
			TimeStamp: Date.now(),
			From: 1
		}
	});
}

const STALE_MS = 20000;

const PREP = new Set([1, 10, 11, 12, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);

/** Map the `Status` object of an SDCP status push to our normalised status. */
export function normalizeSdcpStatus(s: Obj, attributes?: Obj): PrinterStatus {
	const info = isObj(s.PrintInfo) ? s.PrintInfo : {};
	const cur = Array.isArray(s.CurrentStatus)
		? (s.CurrentStatus as unknown[]).map(Number)
		: typeof s.CurrentStatus === 'number'
			? [s.CurrentStatus]
			: [];
	const ps = num(info.Status) ?? 0;
	const err = num(info.ErrorNumber) ?? 0;

	let state: PrinterStatus['state'] = 'idle';
	let cancelled: boolean | undefined;
	if (ps === 14 || err > 0) state = 'error';
	else if (ps === 13 || (PREP.has(ps) && cur.includes(1))) state = 'printing';
	else if (ps === 5 || ps === 6) state = 'paused';
	else if (ps === 9) state = 'done';
	else if (ps === 8 || ps === 7) {
		state = 'failed';
		cancelled = true;
	}

	const layer = num(info.CurrentLayer);
	const totalLayers = num(info.TotalLayer);
	let progress = num(info.Progress) ?? null;
	if (progress === null && layer !== undefined && totalLayers)
		progress = (layer / totalLayers) * 100;
	if (state === 'done') progress = 100;
	if (progress !== null) progress = Math.max(0, Math.min(100, Math.round(progress * 10) / 10));

	// FDM firmware reports ticks in seconds; some resin firmware uses milliseconds.
	let cT = num(info.CurrentTicks);
	let tT = num(info.TotalTicks);
	if (tT !== undefined && tT > 1e6) {
		tT /= 1000;
		if (cT !== undefined) cT /= 1000;
	}
	const active = state === 'printing' || state === 'paused';
	const fileName = safeFileName(info.Filename);

	const out: PrinterStatus = {
		state,
		progress: state === 'idle' ? null : progress,
		fileName: state === 'idle' ? undefined : fileName,
		nozzleC: temp(s.TempOfNozzle),
		bedC: temp(s.TempOfHotbed),
		chamberC: temp(s.TempOfBox)
	};
	if (active || state === 'done') {
		out.layer = layer;
		out.totalLayers = totalLayers;
		out.elapsedSec = cT === undefined ? undefined : Math.round(cT);
		out.remainingSec =
			active && cT !== undefined && tT !== undefined ? Math.max(0, Math.round(tT - cT)) : undefined;
	}
	if (cancelled) out.cancelled = true;
	if (state === 'error') out.message = `Printer reported error ${err || ps}`;
	const fil = extractFilaments(s, attributes);
	if (fil.length) out.filaments = fil;
	out.raw = { printStatus: ps, machineStatus: cur };
	return out;
}

const MAX_FILAMENTS = 16;
const MAX_FILAMENT_STR = 32;
const MAINBOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A MainboardID is echoed back to the device in every request we send, so it must look like an id. */
function cleanMainboardId(v: unknown): string {
	return typeof v === 'string' && MAINBOARD_ID_RE.test(v) ? v : '';
}

/**
 * CANVAS slot info. The Centauri Carbon's public SDCP docs do not define a canvas schema, so
 * this reads any `Canvas*` structure that looks like a list of trays (color + type) and
 * otherwise reports nothing.
 */
export function extractFilaments(...sources: (Obj | undefined)[]): PrinterFilament[] {
	const out: PrinterFilament[] = [];
	const visit = (v: unknown, depth: number) => {
		if (depth > 4) return;
		if (Array.isArray(v)) {
			for (const x of v) {
				if (out.length >= MAX_FILAMENTS) return;
				if (isObj(x) && ('filament_color' in x || 'FilamentColor' in x || 'color' in x)) {
					const color = (x.filament_color ?? x.FilamentColor ?? x.color) as unknown;
					const type = (x.filament_type ?? x.FilamentType ?? x.type ?? x.filament_name) as unknown;
					out.push({
						slot: `A${out.length + 1}`,
						color:
							typeof color === 'string'
								? color.replace(/^0x/i, '#').slice(0, MAX_FILAMENT_STR)
								: undefined,
						type: typeof type === 'string' ? type.slice(0, MAX_FILAMENT_STR) : undefined
					});
				} else visit(x, depth + 1);
			}
		} else if (isObj(v)) for (const x of Object.values(v)) visit(x, depth + 1);
	};
	for (const src of sources) {
		if (!src) continue;
		for (const [k, v] of Object.entries(src)) if (/canvas|tray/i.test(k)) visit(v, 0);
	}
	return out;
}

export function connectSdcp(cfg: PrinterConfig): AdapterHandle {
	const subj = new StatusSubject();
	// OctoEverywhere shared link: the printer keeps its one connection to OctoEverywhere and we
	// ride on it (wss, no port, no polling). Without a link nothing is dialled (`guarded`).
	const found = shareLinkOf(cfg.secrets);
	if (!found) {
		subj.emit({
			state: 'error',
			progress: null,
			message: 'The OctoEverywhere shared link is missing.'
		});
		return { status$: (cb) => subj.subscribe(cb), close: () => (subj.closed = true) };
	}
	const link = found;
	let ws: SocketLike | null = null;
	let attempt = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let stale: ReturnType<typeof setTimeout> | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let mainboardId = cleanMainboardId(cfg.secrets.mainboardId);
	const hostile = new HostileGuard();
	let attributes: Obj | undefined;
	let lastStatus: Obj | undefined;

	let askedAttributes = false;

	const send = (cmd: 1) => {
		if (!ws || ws.readyState !== 1 || !mainboardId) return;
		ws.send(sdcpEnvelope(cmd, {}, mainboardId));
	};

	/**
	 * Close the socket we hold (it hung, or went silent) and retry on the normal backoff, which
	 * through a link is `linkBackoff`. `ws` is cleared first so the close handler ignores it.
	 */
	const dropSocket = (message: string) => {
		const sock = ws;
		ws = null;
		if (sock) {
			sock.onmessage = null;
			try {
				sock.close();
			} catch {
				/* ignore */
			}
		}
		clearTimeout(stale);
		clearTimeout(connectTimer);
		if (subj.closed) return;
		subj.emit({ state: 'offline', progress: null, message });
		clearTimeout(retry);
		retry = setTimeout(() => void open(), delay());
	};
	const armStale = () => {
		clearTimeout(stale);
		stale = setTimeout(() => {
			// Report it, but keep the socket until the long silence limit.
			subj.emit({ state: 'offline', progress: null, message: 'No data from the printer' });
			stale = setTimeout(
				() => dropSocket('No data from the printer'),
				LINK_SILENT_CLOSE_MS - STALE_MS
			);
		}, STALE_MS);
	};

	// A relay that accepts the upgrade and hangs up must not be re-dialled every few seconds:
	// `attempt` resets only once a valid Status/Attributes frame arrived (see `gotData`).
	const delay = () => linkBackoff(attempt++);
	const gotData = () => {
		attempt = 0;
	};

	const scheduleReconnect = () => {
		clearTimeout(stale);
		if (subj.closed) return;
		subj.emit({ state: 'offline', progress: null, message: 'Disconnected' });
		clearTimeout(retry);
		retry = setTimeout(() => void open(), delay());
	};

	async function open() {
		if (subj.closed) return;
		let url: string;
		let pin: SocketPin | undefined;
		try {
			// Resolved and validated on every (re)connect: wss to the link host; every answer must be
			// public and the socket is pinned to the validated address (SNI and certificate checks
			// stay on for the link host).
			const t = await resolveAllowed(link.host, undefined, { allowShareLink: true });
			pin = { ip: t.ip, family: t.family, servername: link.host };
			url = shareLinkSocketUrl(link.origin);
		} catch (e) {
			if (subj.closed) return;
			subj.emit({ state: 'error', progress: null, message: safeError(e) });
			// A refused link may be fixed by DNS or an edit: try again on the slow link backoff.
			retry = setTimeout(() => void open(), delay());
			return;
		}
		if (subj.closed) return;
		try {
			ws = openSocket(url, pin ? { pin } : undefined);
		} catch (e) {
			subj.emit({ state: 'offline', progress: null, message: safeError(e) });
			retry = setTimeout(() => void open(), delay());
			return;
		}
		const sock = ws;
		const budget = new MessageBudget();
		// A peer that accepts the TCP connection but never finishes the handshake.
		clearTimeout(connectTimer);
		connectTimer = setTimeout(() => {
			if (ws === sock && sock.readyState === 0) dropSocket('Timed out connecting to the printer');
		}, CONNECT_TIMEOUT_MS);
		/** Oversized, non-text or flooding peer: drop the socket and come back on a long backoff. */
		const tooBig = (message = OVERSIZED_MESSAGE) => {
			ws = null; // the close handler below then ignores this socket
			sock.onmessage = null;
			clearTimeout(stale);
			try {
				sock.close();
			} catch {
				/* ignore */
			}
			clearTimeout(connectTimer);
			subj.emit({ state: 'error', progress: null, message });
			clearTimeout(retry);
			// Never faster than the slow link backoff either.
			retry = setTimeout(() => void open(), Math.max(hostile.trip(), linkBackoff(attempt++)));
		};
		sock.onopen = () => {
			clearTimeout(connectTimer);
			armStale();
			askedAttributes = false;
			// OctoEverywhere pushes status by itself; the MainboardID comes with it.
		};
		sock.onmessage = (ev) => {
			// Event-handler throws are uncaught exceptions: nothing remote-driven may escape.
			try {
				handle(ev.data, ev.bytes);
			} catch {
				/* hostile or malformed frame: ignore it */
			}
		};
		const handle = (data: unknown, bytes?: number) => {
			// Checked before JSON.parse: nothing over the cap, or past the per-second budget, is parsed.
			// (The socket already refuses a frame over the cap while it is received.)
			if (typeof data !== 'string') return tooBig();
			const size = bytes ?? Buffer.byteLength(data);
			if (size > MAX_REMOTE_MESSAGE_BYTES) return tooBig();
			if (!budget.take(size)) return tooBig(FLOODED_MESSAGE);
			const msg: unknown = JSON.parse(data);
			if (!isObj(msg)) return;
			hostile.good();
			const topic = typeof msg.Topic === 'string' ? msg.Topic : '';
			const id = (msg.MainboardID ??
				(isObj(msg.Data) ? msg.Data.MainboardID : undefined)) as unknown;
			if (!mainboardId) {
				mainboardId = cleanMainboardId(id);
				if (!mainboardId && topic.includes('/'))
					mainboardId = cleanMainboardId(topic.split('/').pop());
			}
			// Through the link the id is known only once the first push arrives: ask for the
			// attributes (Cmd 1, read-only) once, then rely on the pushed status.
			if (mainboardId && !askedAttributes) {
				askedAttributes = true;
				send(1);
			}
			if (isObj(msg.Attributes)) {
				attributes = msg.Attributes;
				if (!mainboardId) mainboardId = cleanMainboardId(attributes.MainboardID);
				gotData();
				if (lastStatus) subj.emit(normalizeSdcpStatus(lastStatus, attributes));
				armStale();
			}
			if (isObj(msg.Status)) {
				lastStatus = msg.Status;
				gotData();
				subj.emit(normalizeSdcpStatus(msg.Status, attributes));
				armStale();
			}
		};
		sock.onerror = () => {
			/* close follows */
		};
		sock.onclose = (ev) => {
			clearTimeout(connectTimer);
			if (ws !== sock) return;
			// 1009: the socket refused a message over the size cap while it arrived.
			if (ev?.code === 1009) tooBig();
			else scheduleReconnect();
		};
	}
	void open();

	return {
		status$: (cb) => subj.subscribe(cb),
		close: () => {
			subj.closed = true;
			clearTimeout(retry);
			clearTimeout(stale);
			clearTimeout(connectTimer);
			const s = ws;
			ws = null;
			try {
				s?.close();
			} catch {
				/* ignore */
			}
		}
	};
}
