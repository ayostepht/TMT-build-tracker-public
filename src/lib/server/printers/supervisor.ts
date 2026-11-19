/**
 * Keeps one adapter connection per enabled printer, mirrors the latest status into the
 * `printers` row (throttled), pushes it to the team's SSE stream and feeds the job lifecycle.
 * One instance per process (`getSupervisor`); started from `startup()`.
 */
import { eq } from 'drizzle-orm';
import { first } from '../db';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { SHARE_LINK_HOST_PLACEHOLDER, shareLinkFor } from '#lib/printers/share-link.ts';
import type { Db } from '../db';
import { printers } from '../db/schema';
import { adapters as defaultAdapters } from './adapters';
import { emitPrinterEvent } from './bus';
import { processStatus } from './jobs';
import { LINK_ONLY_MESSAGE } from './outbound';
import { toConfig } from './store';
import { maskSecrets, type AdapterHandle, type ConnectFn } from './types';
import type { PrinterKind } from '#lib/printers/status.ts';

const WRITE_EVERY_MS = 10_000;

interface Conn {
	handle: AdapterHandle;
	unsub: () => void;
	lastWrite: number;
	lastKey: string;
	/** Serialises the async handling of this printer's statuses (see `onStatus`). */
	busy: boolean;
	/** The newest status that arrived while one was being handled; older ones are superseded. */
	next: PrinterStatus | null;
	/** Settles when the status being handled (and any queued behind it) is done. */
	chain: Promise<void>;
}

export class Supervisor {
	private conns = new Map<string, Conn>();
	constructor(
		private db: Db,
		private adapters: Record<PrinterKind, ConnectFn> = defaultAdapters,
		private writeEveryMs = WRITE_EVERY_MS
	) {}

	/** Connect every enabled printer. */
	async start(): Promise<void> {
		const rows = await this.db
			.select({ id: printers.id })
			.from(printers)
			.where(eq(printers.enabled, true));
		for (const p of rows) await this.connect(p.id);
	}

	/** (Re)connect one printer after it was added or edited; disconnect when disabled or deleted. */
	async refresh(printerId: string): Promise<void> {
		this.disconnect(printerId);
		const row = await first(
			this.db.select({ enabled: printers.enabled }).from(printers).where(eq(printers.id, printerId))
		);
		if (row?.enabled) await this.connect(printerId);
	}

	private async connect(printerId: string): Promise<void> {
		if (this.conns.has(printerId)) return;
		const row = await first(this.db.select().from(printers).where(eq(printers.id, printerId)));
		if (!row) return;
		// Another connect (a refresh racing the start) may have won while we were reading.
		if (this.conns.has(printerId)) return;
		if (row.kind === 'manual') return; // not connected: nothing to dial, ever
		const cfg = toConfig(row);
		// Only a printer on an OctoEverywhere link is ever connected.
		if (!shareLinkFor(cfg.kind, cfg.secrets)) return;
		let handle: AdapterHandle;
		try {
			handle = this.adapters[cfg.kind](cfg);
		} catch (e) {
			console.error(
				'[tmt] printer connect failed',
				row.name,
				maskSecrets(e instanceof Error ? e.message : '')
			);
			return;
		}
		const conn: Conn = {
			handle,
			unsub: () => {},
			lastWrite: 0,
			lastKey: '',
			busy: false,
			next: null,
			chain: Promise.resolve()
		};
		conn.unsub = handle.status$((s) => this.onStatus(printerId, conn, s));
		this.conns.set(printerId, conn);
	}

	/** Drop a connection (printer deleted). */
	remove(printerId: string): void {
		this.disconnect(printerId);
	}

	private disconnect(printerId: string): void {
		const c = this.conns.get(printerId);
		if (!c) return;
		c.unsub();
		c.handle.close();
		this.conns.delete(printerId);
	}

	/**
	 * A status arrived from the socket. Handling it is async (database), and socket callbacks do not
	 * wait, so statuses of one printer are handled strictly one at a time: while one is in flight
	 * the newest later one is kept (older ones are superseded, the printer reports its full state
	 * each time) and handled right after. This keeps a job update and its build mutation from
	 * interleaving with the next status. Errors are logged here and never escape as an unhandled
	 * rejection.
	 */
	private onStatus(printerId: string, conn: Conn, s: PrinterStatus): void {
		if (conn.busy) {
			conn.next = s;
			return;
		}
		conn.busy = true;
		conn.chain = (async () => {
			let cur: PrinterStatus | null = s;
			while (cur) {
				conn.next = null;
				try {
					await this.handleStatus(printerId, conn, cur);
				} catch (e) {
					console.error(
						'[tmt] printer status error',
						maskSecrets(e instanceof Error ? e.message : String(e))
					);
				}
				cur = conn.next;
			}
		})()
			.catch(() => {})
			.finally(() => {
				conn.busy = false;
			});
	}

	/** Resolves when every status received so far has been handled (tests, orderly shutdown). */
	async idle(): Promise<void> {
		for (const c of [...this.conns.values()]) await c.chain;
	}

	private async handleStatus(printerId: string, conn: Conn, s: PrinterStatus): Promise<void> {
		{
			const now = Date.now();
			const row = await first(
				this.db
					.select({ org: printers.organizationId })
					.from(printers)
					.where(eq(printers.id, printerId))
			);
			if (!row) return this.disconnect(printerId);
			const key = `${s.state}|${s.fileName ?? ''}`;
			if (key !== conn.lastKey || now - conn.lastWrite >= this.writeEveryMs) {
				conn.lastKey = key;
				conn.lastWrite = now;
				const set: Partial<typeof printers.$inferInsert> = {
					lastStatus: s as unknown as Record<string, unknown>
				};
				if (s.state !== 'offline') set.lastSeenAt = new Date(now);
				await this.db.update(printers).set(set).where(eq(printers.id, printerId));
			}
			const jobsChanged =
				s.state !== 'offline' &&
				(await processStatus(this.db, printerId, s, new Date(now))).changed;
			// A job started, linked or finished: open pages reload their job list (the Now printing tile).
			if (jobsChanged) emitPrinterEvent(row.org, { type: 'job', printerId });
			emitPrinterEvent(row.org, {
				type: 'status',
				printerId,
				status: s,
				lastSeenAt: s.state !== 'offline' ? new Date(now).toISOString() : undefined
			});
		}
	}

	stop(): void {
		for (const id of [...this.conns.keys()]) this.disconnect(id);
	}

	get size(): number {
		return this.conns.size;
	}
}

const KEY = Symbol.for('tmt.printer-supervisor');
type G = typeof globalThis & { [KEY]?: Supervisor };
const g = globalThis as G;

/** Create the process-wide supervisor and connect the enabled printers in the background (a failure is logged, never thrown). */
export function startSupervisor(db: Db): Supervisor {
	if (!g[KEY]) {
		const sup = new Supervisor(db);
		g[KEY] = sup;
		sup
			.start()
			.catch((e) =>
				console.error(
					'[tmt] printer supervisor start failed',
					maskSecrets(e instanceof Error ? e.message : String(e))
				)
			);
	}
	return g[KEY];
}

/** The running supervisor, or null before startup. */
export function getSupervisor(): Supervisor | null {
	return g[KEY] ?? null;
}

/**
 * One-shot connection test: connect, wait for the first real status (or the timeout), then
 * disconnect. Never touches the database.
 */
export async function testConnection(
	cfg: import('./types').PrinterConfig,
	timeoutMs = 8000,
	adapters: Record<PrinterKind, ConnectFn> = defaultAdapters
): Promise<{ ok: boolean; status: PrinterStatus | null; message?: string }> {
	if (cfg.kind === 'manual')
		return {
			ok: false,
			status: null,
			message: 'This printer is not connected, so there is nothing to test.'
		};
	if (!shareLinkFor(cfg.kind, cfg.secrets))
		return {
			ok: false,
			status: null,
			message:
				cfg.host === SHARE_LINK_HOST_PLACEHOLDER
					? 'The OctoEverywhere shared link is missing. Edit the printer and enter it again.'
					: LINK_ONLY_MESSAGE
		};
	return new Promise((resolve) => {
		let last: PrinterStatus | null = null;
		let handle: AdapterHandle | null = null;
		let finished = false;
		const done = (ok: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(t);
			unsub();
			handle?.close();
			resolve({
				ok,
				status: last,
				message: ok
					? undefined
					: (last?.message ??
						'No answer from the printer. Check the link and that the printer is on.')
			});
		};
		let unsub = () => {};
		const t = setTimeout(() => done(false), timeoutMs);
		try {
			handle = adapters[cfg.kind](cfg);
		} catch {
			return done(false);
		}
		unsub = handle.status$((s) => {
			last = s;
			if (s.state === 'error') done(false);
			else if (s.state !== 'offline') done(true);
		});
		if (finished) unsub();
	});
}
