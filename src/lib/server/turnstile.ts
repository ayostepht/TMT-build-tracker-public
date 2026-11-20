/**
 * Optional Cloudflare Turnstile on starting a demo (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`,
 * see `config.ts`). Verification is fail closed: no token, a rejected token, a network error, a
 * timeout or an unreadable answer all refuse. Neither the secret nor the token is ever logged.
 */
import { turnstileConfig, turnstileHostnames } from '#lib/server/config.ts';
import type { CspSources } from '#lib/server/analytics.ts';

export type PageCspSources = CspSources & { frameSrc?: string[] };

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_TIMEOUT_MS = 5000;
/** Cloudflare tokens are at most 2048 characters. */
const MAX_TOKEN = 2048;

/** The action the demo widget is rendered with and the answer must carry. */
export const TURNSTILE_DEMO_ACTION = 'demo-start';

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

/**
 * Checks a widget token with Cloudflare. `missing`: no usable token (nothing was sent);
 * `failed`: Cloudflare said no or the action/hostname is wrong; `error`: it could not be asked, answered oddly, or no hostname is configured. Only `ok` lets a demo start.
 */
export async function verifyTurnstile(
	token: unknown,
	remoteIp: string | null,
	opts: {
		secretKey: string;
		fetch?: typeof fetch;
		timeoutMs?: number;
		/** Defaults to `TURNSTILE_DEMO_ACTION`. */
		expectedAction?: string;
		/** Defaults to `turnstileHostnames()`; an empty list fails closed with `error`. */
		expectedHosts?: string[];
	}
): Promise<TurnstileResult> {
	if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return 'missing';
	const hosts = (opts.expectedHosts ?? turnstileHostnames()).map((h) => h.toLowerCase());
	if (hosts.length === 0) return 'error';
	const action = opts.expectedAction ?? TURNSTILE_DEMO_ACTION;
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
		const json = (await res.json()) as {
			success?: unknown;
			action?: unknown;
			hostname?: unknown;
		} | null;
		if (!json || json.success !== true) return 'failed';
		// Cloudflare's canonical checks: the token was minted for this action and for one of our hostnames.
		if (json.action !== action) return 'failed';
		if (typeof json.hostname !== 'string' || !hosts.includes(json.hostname.toLowerCase()))
			return 'failed';
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
