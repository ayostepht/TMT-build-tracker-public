/** Per-IP limit on starting demos: a sliding window in memory (one instance; a restart resets it). */
const hits = new Map<string, number[]>();
const HOUR = 3_600_000;

/**
 * Take one demo start for `ip`. Returns 0 when allowed, else the seconds until the oldest start in
 * the window expires. `perHour` 0 refuses everything.
 */
export function takeDemoStart(ip: string, perHour: number, now = Date.now()): number {
	if (hits.size > 5000) {
		for (const [k, v] of hits) if (v.every((t) => now - t > HOUR)) hits.delete(k);
	}
	const recent = (hits.get(ip) ?? []).filter((t) => now - t < HOUR);
	if (recent.length >= perHour) {
		hits.set(ip, recent);
		return Math.max(1, Math.ceil((recent[0] + HOUR - now) / 1000));
	}
	recent.push(now);
	hits.set(ip, recent);
	return 0;
}

/** Forget every counter (tests). */
export function resetDemoLimits(): void {
	hits.clear();
}
