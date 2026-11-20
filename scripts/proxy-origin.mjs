// Preloaded with `node --import ./scripts/proxy-origin.mjs build` (see `npm start`
// and the Dockerfile). Without a protocol header adapter-node assumes https, so
// SvelteKit rejects form posts made over plain http as cross-site. This makes the
// request origin explicit and safe:
//
//  - PUBLIC_URL (or BETTER_AUTH_URL / ORIGIN) set: that origin is used for every
//    request, whatever headers the client sends.
//  - Unset: the scheme comes from X-Forwarded-Proto (set by reverse proxies such
//    as Nginx Proxy Manager) and defaults to http; the host from X-Forwarded-Host
//    or Host. A browser cannot forge these on a cross-site request, and the
//    Origin header must still match, so CSRF protection stays intact.
import http from 'node:http';
import { installResponseDefaults } from './response-defaults.mjs';

// Static files and error pages never reach hooks.server.ts: give them the security headers too.
installResponseDefaults(http.ServerResponse.prototype);

// TRUST_CLOUDFLARE=1: the origin is reachable only through Cloudflare, which sets CF-Connecting-IP to
// the real client and overwrites any copy the client sent. adapter-node then reads that header for
// getClientAddress() (everything that rate-limits per client uses it), and a request without it
// fails closed. It wins over ADDRESS_HEADER / XFF_DEPTH. Never set it when the port is also open
// to the internet: anyone could then pick their own address.
if (/^(1|true)$/i.test((process.env.TRUST_CLOUDFLARE ?? '').trim())) {
	const other = (process.env.ADDRESS_HEADER ?? '').trim().toLowerCase();
	if (other && other !== 'cf-connecting-ip') {
		console.warn(
			'[tmt] TRUST_CLOUDFLARE is set: ADDRESS_HEADER is ignored, CF-Connecting-IP is used.'
		);
	}
	process.env.ADDRESS_HEADER = 'cf-connecting-ip';
	delete process.env.XFF_DEPTH;
}

process.env.PROTOCOL_HEADER ??= 'x-forwarded-proto';
process.env.HOST_HEADER ??= 'x-forwarded-host';

function configuredOrigin() {
	const raw = (
		process.env.PUBLIC_URL ||
		process.env.BETTER_AUTH_URL ||
		process.env.ORIGIN ||
		''
	).trim();
	if (!raw) return null;
	const url = new URL(raw);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`PUBLIC_URL must start with http:// or https://: ${raw}`);
	}
	return url;
}

const fixed = configuredOrigin();

// adapter-node (6.0.2 and later) reads ORIGIN itself, uses it for every request and refuses to
// start when it is set but empty or not a URL. Hand it the origin chosen above (PUBLIC_URL wins
// over BETTER_AUTH_URL and ORIGIN, as in config.ts), or nothing, so a blank ORIGIN means "unset".
if (fixed) process.env.ORIGIN = fixed.origin;
else delete process.env.ORIGIN;

const first = (value) =>
	String(Array.isArray(value) ? value[0] : (value ?? ''))
		.split(',')[0]
		.trim();

// Private marker for the "reverse proxy in front" log hint only (client-ip.ts). This file adds
// x-forwarded-proto itself on every request, so the hint cannot look at that header: the
// marker records whether the CLIENT sent forwarding headers. Any inbound copy of the marker
// is stripped first, so it cannot be spoofed. Never trust it for anything else.
const FORWARD_MARKER = 'x-tmt-forwarded-original';
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded'];

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, ...rest) {
	if (event === 'request' && req?.headers) {
		const h = req.headers;
		delete h[FORWARD_MARKER];
		if (FORWARD_HEADERS.some((name) => name in h)) h[FORWARD_MARKER] = '1';
		if (fixed) {
			h['x-forwarded-proto'] = fixed.protocol.slice(0, -1);
			h['x-forwarded-host'] = fixed.host;
		} else {
			const proto = first(h['x-forwarded-proto']).toLowerCase();
			h['x-forwarded-proto'] = proto === 'https' ? 'https' : 'http';
			const host = first(h['x-forwarded-host']);
			if (host) h['x-forwarded-host'] = host;
			else delete h['x-forwarded-host'];
		}
	}
	return emit.call(this, event, req, ...rest);
};
