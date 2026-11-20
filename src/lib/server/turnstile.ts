/**
 * Optional Cloudflare Turnstile on starting a demo (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`,
 * see `config.ts`). Verification is fail closed: no token, a rejected token, a network error, a
 * timeout or an unreadable answer all refuse. Neither the secret nor the token is ever logged.
 */
import { publicUrl, turnstileConfig } from '#lib/server/config.ts';
import type { CspSources } from '#lib/server/analytics.ts';

export type PageCspSources = CspSources & { frameSrc?: string[] };

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_TIMEOUT_MS = 5000;
/** Cloudflare tokens are at most 2048 characters. */
const MAX_TOKEN = 2048;

export type TurnstileResult = 'ok' | 'missing' | 'failed' | 'error';

export function turnstileEnabled(): boolean {
	return turnstileConfig() !== null;
}

/** The page CSP sources plus Turnstile's exact origin (script, frame and connect). */
export function withTurnstile(base: CspSources): Required<PageCspSources> {
	return {
		scriptSrc: [...base.scriptSrc, TURNSTILE_ORIGIN],
		connectSrc: [...base.connectSrc, TURNSTILE_ORIGIN],
		frameSrc: [TURNSTILE_ORIGIN]
	};
}

function publicHost(): string | null {
	try {
		const u = publicUrl();
		return u ? new URL(u).hostname : null;
	} catch {
		return null;
	}
}

/**
 * Checks a widget token with Cloudflare. `missing`: no usable token (nothing was sent);
 * `failed`: Cloudflare said no; `error`: it could not be asked or answered oddly. Only `ok` lets a demo start.
 */
export async function verifyTurnstile(
	token: unknown,
	remoteIp: string | null,
	opts: {
		secretKey: string;
		fetch?: typeof fetch;
		timeoutMs?: number;
		expectedHost?: string | null;
	}
): Promise<TurnstileResult> {
	if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return 'missing';
	const body = new URLSearchParams({ secret: opts.secretKey, response: token });
	if (remoteIp) body.set('remoteip', remoteIp);
	try {
		const res = await (opts.fetch ?? fetch)(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			body,
			redirect: 'error',
			signal: AbortSignal.timeout(opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS)
		});
		if (!res.ok) return 'error';
		const json = (await res.json()) as { success?: unknown; hostname?: unknown };
		if (!json || json.success !== true) return 'failed';
		// A token minted for another site's widget must not pass: compare with PUBLIC_URL when both are known.
		if (typeof json.hostname === 'string' && json.hostname) {
			const expected = opts.expectedHost === undefined ? publicHost() : opts.expectedHost;
			if (expected && json.hostname.toLowerCase() !== expected.toLowerCase()) return 'failed';
		}
		return 'ok';
	} catch {
		return 'error';
	}
}

/** The user-facing refusal for a result that is not `ok`. */
export function turnstileMessage(result: Exclude<TurnstileResult, 'ok'>): string {
	return result === 'error'
		? 'We could not check that you are a person right now. Please try again in a moment.'
		: 'Please complete the check below to start the demo.';
}
