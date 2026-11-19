import { isIP } from 'node:net';

/** Per-IP limit on starting demos: a sliding window in memory (one instance; a restart resets it). */
const hits = new Map<string, number[]>();
/** Starts of any address, for the global per-minute limit. */
let recentStarts: number[] = [];
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Most addresses remembered at once; the oldest is dropped past this. */
export const MAX_TRACKED_ADDRESSES = 5000;

/** Expand an IPv6 address to its 8 groups, or null when it is not one. */
function groupsV6(addr: string): number[] | null {
	let a = addr.toLowerCase();
	const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
	if (tail) {
		const p = tail[1].split('.').map(Number);
		if (p.some((n) => n > 255)) return null;
		a =
			a.slice(0, tail.index) +
			((p[0] << 8) | p[1]).toString(16) +
			':' +
			((p[2] << 8) | p[3]).toString(16);
	}
	const halves = a.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - head.length - rest.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
	const nums = all.map((g) => Number.parseInt(g, 16));
	return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
		? nums
		: null;
}

/**
 * The key a client address is limited under: IPv4 as is, an IPv4-mapped IPv6 address as the plain
 * IPv4, any other IPv6 address as its /64 (one subscriber holds a whole /64, so per-address
 * buckets would make the limit meaningless). Anything unparseable keeps its text.
 */
export function demoLimitKey(raw: string): string {
	const addr = raw.trim().split('%')[0];
	const kind = isIP(addr);
	if (kind === 4) return addr;
	if (kind !== 6) return raw.trim();
	const g = groupsV6(addr);
	if (!g) return addr.toLowerCase();
	if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff)
		return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
	return (
		g
			.slice(0, 4)
			.map((n) => n.toString(16))
			.join(':') + '::/64'
	);
}

/**
 * Take one demo start for `ip`. Returns 0 when allowed, else the seconds to wait: until the oldest
 * start in the per-address hour window expires, or in the global per-minute window. `perHour` 0 or
 * `perMinute` 0 refuses everything; `perMinute` undefined has no global limit.
 */
export function takeDemoStart(
	ip: string,
	perHour: number,
	now = Date.now(),
	perMinute?: number
): number {
	const key = demoLimitKey(ip);
	recentStarts = recentStarts.filter((t) => now - t < MINUTE);
	if (perMinute !== undefined && recentStarts.length >= perMinute)
		return Math.max(1, Math.ceil(((recentStarts[0] ?? now) + MINUTE - now) / 1000));
	if (hits.size >= MAX_TRACKED_ADDRESSES) {
		for (const [k, v] of hits) if (v.every((t) => now - t > HOUR)) hits.delete(k);
		// Still full: drop the oldest-inserted entries (Map keeps insertion order).
		for (const k of hits.keys()) {
			if (hits.size < MAX_TRACKED_ADDRESSES) break;
			hits.delete(k);
		}
	}
	const recent = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
	if (recent.length >= perHour) {
		hits.delete(key);
		hits.set(key, recent);
		return Math.max(1, Math.ceil(((recent[0] ?? now) + HOUR - now) / 1000));
	}
	recent.push(now);
	hits.delete(key);
	hits.set(key, recent);
	recentStarts.push(now);
	return 0;
}

/** Forget every counter (tests). */
export function resetDemoLimits(): void {
	hits.clear();
	recentStarts = [];
}

/** Addresses currently tracked (tests). */
export function trackedAddressCount(): number {
	return hits.size;
}
