import { and, eq, ne, sql } from 'drizzle-orm';
import {
	MANUAL_HOST_PLACEHOLDER,
	PRINTER_KIND_INFO,
	PRINTER_KINDS,
	type PrinterKind,
	type PrinterPublic,
	type PrinterStatus
} from '#lib/printers/status.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import {
	parseShareLink,
	shareLinkFor,
	supportsShareLink,
	SHARE_LINK_HOST_PLACEHOLDER,
	SHARE_LINK_KEY
} from '#lib/printers/share-link.ts';
import { ApiError } from '../access';
import type { Db } from '../db';
import { linkPrintersPerWorkspace, linkPrintersTotal, manualPrintersPerWorkspace } from '../config';
import { QuotaError } from '../quota';
import { printers } from '../db/schema';
import { decryptSecrets, encryptSecrets, type Secrets } from './secrets';
import { LINK_ONLY_MESSAGE } from './outbound';
import type { PrinterConfig } from './types';

type Row = typeof printers.$inferSelect;
type Obj = Record<string, unknown>;

const bad = (m: string): never => {
	throw new ApiError(400, m);
};

/** Names of fields that are not secret: shown back to the user. */
const publicKeys = (kind: PrinterKind) =>
	PRINTER_KIND_INFO[kind].secrets.filter((s) => !s.secret).map((s) => s.key);

export function toPublic(r: Row): PrinterPublic {
	const kind = r.kind as PrinterKind;
	const secrets = decryptSecrets(r.secretEnc);
	const pub = publicKeys(kind);
	const connection: PrinterPublic['connection'] = kind === 'manual' ? 'manual' : 'link';
	return {
		id: r.id,
		organizationId: r.organizationId,
		name: r.name,
		kind,
		host: r.host,
		catalogId: r.catalogId,
		enabled: r.enabled,
		cameraEnabled: r.cameraEnabled,
		lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
		status: (r.lastStatus as PrinterStatus | null) ?? null,
		secretsSet: Object.keys(secrets).filter((k) => secrets[k]),
		identifiers: Object.fromEntries(pub.filter((k) => secrets[k]).map((k) => [k, secrets[k]])),
		connection,
		// Manual printers are never dialled. A link printer without a usable link (an old row, or
		// secrets that could not be decrypted) is never dialled either.
		blocked:
			connection === 'link' && !shareLinkFor(kind, secrets)
				? r.host === SHARE_LINK_HOST_PLACEHOLDER
					? 'The OctoEverywhere shared link is missing. Edit the printer and enter it again.'
					: LINK_ONLY_MESSAGE
				: null
	};
}

export function toConfig(r: Row): PrinterConfig {
	return {
		id: r.id,
		kind: r.kind as PrinterKind,
		host: r.host,
		secrets: decryptSecrets(r.secretEnc)
	};
}

export function listPrinters(db: Db, orgId: string): Row[] {
	return db
		.select()
		.from(printers)
		.where(eq(printers.organizationId, orgId))
		.orderBy(printers.name)
		.all();
}

export function getPrinter(db: Db, id: string): Row | undefined {
	return db.select().from(printers).where(eq(printers.id, id)).get();
}

interface ParsedInput {
	name?: string;
	kind?: PrinterKind;
	catalogId?: string | null;
	enabled?: boolean;
	cameraEnabled?: boolean;
	secrets?: Secrets; // only the fields supplied
}

export function parsePrinterInput(
	body: unknown,
	partial: boolean,
	/** The stored kind when the body (an edit) does not carry one. */
	kindHint?: PrinterKind
): ParsedInput {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('Invalid body');
	const o = body as Obj;
	const out: ParsedInput = {};
	if (o.name !== undefined || !partial) {
		if (typeof o.name !== 'string' || !o.name.trim()) bad('Give the printer a name');
		out.name = (o.name as string).trim().slice(0, 80);
	}
	if (o.kind !== undefined || !partial) {
		if (!(PRINTER_KINDS as readonly unknown[]).includes(o.kind)) bad('Unknown printer type');
		out.kind = o.kind as PrinterKind;
	}
	const kindNow = out.kind ?? kindHint;
	if (o.catalogId !== undefined) {
		if (o.catalogId === null || o.catalogId === '') out.catalogId = null;
		else if (typeof o.catalogId !== 'string' || !catalogPrinter(o.catalogId))
			bad('Unknown catalog printer');
		else out.catalogId = o.catalogId;
	}
	if (o.enabled !== undefined) {
		if (typeof o.enabled !== 'boolean') bad('enabled must be true or false');
		out.enabled = o.enabled as boolean;
	}
	if (o.cameraEnabled !== undefined) {
		if (typeof o.cameraEnabled !== 'boolean') bad('cameraEnabled must be true or false');
		out.cameraEnabled = o.cameraEnabled as boolean;
	}
	if (o.secrets !== undefined && kindNow === 'manual') {
		out.secrets = {}; // nothing to keep: no link or keys
	} else if (o.secrets !== undefined) {
		if (typeof o.secrets !== 'object' || o.secrets === null || Array.isArray(o.secrets))
			bad('secrets must be an object');
		const s: Secrets = {};
		for (const [k, v] of Object.entries(o.secrets as Obj)) {
			if (typeof v !== 'string' || v.length > 300) bad(`${k} must be text`);
			s[k] = (v as string).trim();
			if (k === SHARE_LINK_KEY && s[k] && kindNow && !supportsShareLink(kindNow))
				bad('This printer type has no OctoEverywhere link.');
			if (k === SHARE_LINK_KEY && s[k]) {
				// Validated and normalised; the error never echoes the (secret) link.
				const c = parseShareLink(s[k]);
				if (!c.ok) bad(c.error);
				else s[k] = c.origin;
			}
		}
		out.secrets = s;
	}
	return out;
}

/** Merge supplied secret fields over the stored ones; an empty string clears a field, an absent key keeps it. */
function mergeSecrets(kind: PrinterKind, current: Secrets, supplied: Secrets | undefined): Secrets {
	const allowed = new Set(PRINTER_KIND_INFO[kind].secrets.map((s) => s.key));
	const next: Secrets = Object.fromEntries(Object.entries(current).filter(([k]) => allowed.has(k)));
	for (const [k, v] of Object.entries(supplied ?? {})) {
		if (!allowed.has(k)) continue;
		if (v) next[k] = v;
		else delete next[k];
	}
	return next;
}

/**
 * Hosted site: a workspace may hold only so many printers reached through an OctoEverywhere link
 * (`linkPrintersPerWorkspace`, default 3): each is a long-lived connection to a third party. Link
 * printers are exactly the rows whose host is the link placeholder. Call it synchronously right
 * before the write (the database is synchronous, so two requests cannot both pass).
 */
export function assertLinkRoom(db: Db, orgId: string, exceptId?: string): void {
	const count = (inOrg: boolean) =>
		db
			.select({ n: sql<number>`count(*)` })
			.from(printers)
			.where(
				and(
					inOrg ? eq(printers.organizationId, orgId) : undefined,
					eq(printers.host, SHARE_LINK_HOST_PLACEHOLDER),
					exceptId ? ne(printers.id, exceptId) : undefined
				)
			)
			.get()?.n ?? 0;
	const limit = linkPrintersPerWorkspace();
	if (limit !== null) {
		const n = count(true);
		if (n >= limit)
			throw new QuotaError(
				limit === 0
					? 'Printers cannot be connected through an OctoEverywhere link on this server. Ask the admin.'
					: `This workspace already has ${n} ${n === 1 ? 'printer' : 'printers'} connected through OctoEverywhere links, the limit on this server. Remove one or ask the admin.`
			);
	}
	const total = linkPrintersTotal();
	if (total !== null && count(false) >= total)
		throw new QuotaError(
			'This server has reached its limit of printers connected through OctoEverywhere links. Ask the admin.'
		);
}

/** Hosted site: a workspace may hold only so many not-connected printers (`manualPrintersPerWorkspace`, default 10). */
export function assertManualRoom(db: Db, orgId: string, exceptId?: string): void {
	const limit = manualPrintersPerWorkspace();
	if (limit === null) return;
	const n =
		db
			.select({ n: sql<number>`count(*)` })
			.from(printers)
			.where(
				and(
					eq(printers.organizationId, orgId),
					eq(printers.kind, 'manual'),
					exceptId ? ne(printers.id, exceptId) : undefined
				)
			)
			.get()?.n ?? 0;
	if (n < limit) return;
	throw new QuotaError(
		limit === 0
			? 'Printers that are not connected cannot be added on this server. Ask the admin.'
			: `This workspace already has ${n} ${n === 1 ? 'printer' : 'printers'} that are not connected, the limit on this server. Remove one or ask the admin.`
	);
}

/**
 * Stored secrets belong to the link they were saved for (the link itself is the secret):
 *  - same link: the stored secrets (API key, mainboard id) are kept;
 *  - another link: nothing is carried over, the typed link and keys are the credentials (a stale
 *    API key never rides along to a different relay host);
 *  - no link typed: the stored ones stay.
 * `supplied` is what the caller typed (links already normalised).
 */
export function secretsForLink(
	kind: PrinterKind,
	stored: Secrets,
	supplied: Secrets | undefined
): Secrets {
	const curLink = shareLinkFor(kind, stored);
	const typed = supplied?.[SHARE_LINK_KEY];
	if (
		typed === undefined ||
		(curLink && shareLinkFor(kind, { [SHARE_LINK_KEY]: typed })?.host === curLink.host)
	)
		return stored;
	return {}; // a different link (or a cleared one): start from nothing
}

export function createPrinter(db: Db, orgId: string, userId: string, body: unknown): Row {
	const p = parsePrinterInput(body, false);
	const kind = p.kind!;
	const secrets = mergeSecrets(kind, {}, p.secrets);
	const linked = !!shareLinkFor(kind, secrets);
	if (kind !== 'manual' && !linked) bad('Paste the OctoEverywhere shared link');
	if (kind === 'manual') p.cameraEnabled = false;
	return db.transaction((tx) => {
		// Duplicate-link check (same link already used in another workspace) would go here: skipped, it needs a keyed-hash column (schema change).
		if (linked) assertLinkRoom(tx, orgId);
		if (kind === 'manual') assertManualRoom(tx, orgId);
		return tx
			.insert(printers)
			.values({
				organizationId: orgId,
				name: p.name!,
				kind,
				host: linked ? SHARE_LINK_HOST_PLACEHOLDER : MANUAL_HOST_PLACEHOLDER,
				port: null,
				catalogId: p.catalogId ?? null,
				enabled: p.enabled ?? true,
				cameraUrl: null,
				cameraEnabled: p.cameraEnabled ?? true,
				secretEnc: Object.keys(secrets).length ? encryptSecrets(secrets) : null,
				createdBy: userId
			})
			.returning()
			.get();
	});
}

export function updatePrinter(db: Db, id: string, orgId: string, body: unknown): Row {
	// Pausing and renaming always stay possible so an old row can be tidied.
	const o = (typeof body === 'object' && body !== null ? body : {}) as Obj;
	const harmless = Object.entries(o).every(
		([k, v]) => k === 'name' || (k === 'enabled' && v === false)
	);
	const cur = db
		.select()
		.from(printers)
		.where(and(eq(printers.id, id), eq(printers.organizationId, orgId)))
		.get();
	if (!cur) throw new ApiError(404, 'Not found');
	const p = parsePrinterInput(body, true, cur.kind as PrinterKind);
	const kind = p.kind ?? (cur.kind as PrinterKind);
	const kindChanged = kind !== cur.kind;
	const manual = kind === 'manual';
	const secrets = mergeSecrets(
		kind,
		kindChanged ? {} : secretsForLink(kind, decryptSecrets(cur.secretEnc), p.secrets),
		p.secrets
	);
	const linked = !!shareLinkFor(kind, secrets);
	if (!harmless && !manual && !linked) bad('Paste the OctoEverywhere shared link');
	const set: Partial<typeof printers.$inferInsert> = {
		secretEnc: Object.keys(secrets).length ? encryptSecrets(secrets) : null
	};
	if (p.name !== undefined) set.name = p.name;
	if (p.kind !== undefined) set.kind = p.kind;
	if (manual) {
		set.host = MANUAL_HOST_PLACEHOLDER;
		set.port = null;
		set.cameraEnabled = false;
	} else if (linked) {
		set.host = SHARE_LINK_HOST_PLACEHOLDER; // the link is the destination
		set.port = null;
	}
	if (p.catalogId !== undefined) set.catalogId = p.catalogId;
	if (p.enabled !== undefined) set.enabled = p.enabled;
	if (p.cameraEnabled !== undefined && !manual) set.cameraEnabled = p.cameraEnabled;
	set.cameraUrl = null; // a custom camera address no longer exists
	return db.transaction((tx) => {
		// A printer that becomes (or stays) a link printer counts against the cap, except when this
		// edit only tidies it (pause, rename) or it was one already.
		if (linked && !harmless && cur.host !== SHARE_LINK_HOST_PLACEHOLDER)
			assertLinkRoom(tx, orgId, id);
		if (manual && cur.kind !== 'manual') assertManualRoom(tx, orgId, id);
		return tx.update(printers).set(set).where(eq(printers.id, id)).returning().get();
	});
}

export function deletePrinter(db: Db, id: string, orgId: string): void {
	const r = db
		.delete(printers)
		.where(and(eq(printers.id, id), eq(printers.organizationId, orgId)))
		.returning({ id: printers.id })
		.get();
	if (!r) throw new ApiError(404, 'Not found');
}

/** Config for a connection test from the form: stored secrets of `id` (if given) overlaid with typed ones. */
export function configFromInput(db: Db, orgId: string, body: unknown): PrinterConfig {
	const o = (typeof body === 'object' && body !== null ? body : {}) as Obj;
	let stored: Row | undefined;
	if (typeof o.id === 'string') {
		stored = db
			.select()
			.from(printers)
			.where(and(eq(printers.id, o.id), eq(printers.organizationId, orgId)))
			.get();
		if (!stored) throw new ApiError(404, 'Not found');
	}
	const kind = ((o.kind as string) ?? stored?.kind) as PrinterKind;
	if (!(PRINTER_KINDS as readonly unknown[]).includes(kind)) bad('Unknown printer type');
	const p = parsePrinterInput({ ...o, name: 'test', kind }, true, kind);
	if (kind === 'manual')
		return { id: stored?.id ?? 'test', kind, host: MANUAL_HOST_PLACEHOLDER, secrets: {} };
	const keep =
		stored && stored.kind === kind
			? secretsForLink(kind, decryptSecrets(stored.secretEnc), p.secrets)
			: {};
	const secrets = mergeSecrets(kind, keep, p.secrets);
	if (!shareLinkFor(kind, secrets)) bad('Paste the OctoEverywhere shared link');
	return { id: stored?.id ?? 'test', kind, host: SHARE_LINK_HOST_PLACEHOLDER, secrets };
}

/** Number of printers per workspace, for the given workspaces (the top nav's Printers link). */
export function printerCounts(db: Db, orgIds: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const id of orgIds) out[id] = listPrinters(db, id).length;
	return out;
}
