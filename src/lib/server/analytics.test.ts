import { describe, expect, it } from 'vitest';
import {
	analyticsConfig,
	analyticsCspSources,
	analyticsForRequest,
	analyticsProblems,
	cloudflareMayReport,
	doNotTrack,
	isAnalyticsExcluded,
	sanitizeAnalyticsPath
} from './analytics.ts';
import { securityHeaders, withExtraCspSources } from './security-headers.ts';

const UMAMI_ID = '9a3b2c1d-1234-4abc-8def-0123456789ab';
const CF_TOKEN = '0123456789abcdef0123456789abcdef';

describe('analyticsConfig', () => {
	it('is off when unset, empty or unknown', () => {
		expect(analyticsConfig({})).toBeNull();
		expect(analyticsConfig({ ANALYTICS_PROVIDER: '' })).toBeNull();
		expect(analyticsConfig({ ANALYTICS_PROVIDER: 'google' })).toBeNull();
		expect(analyticsProblems({})).toEqual([]);
		expect(analyticsProblems({ ANALYTICS_PROVIDER: 'google' })).toHaveLength(1);
	});

	it('plausible needs a domain and defaults to the hosted manual script', () => {
		expect(analyticsConfig({ ANALYTICS_PROVIDER: 'plausible' })).toBeNull();
		expect(analyticsProblems({ ANALYTICS_PROVIDER: 'plausible' })).toHaveLength(1);
		expect(
			analyticsConfig({ ANALYTICS_PROVIDER: 'Plausible', PLAUSIBLE_DOMAIN: 'tmt.example.com' })
		).toEqual({
			provider: 'plausible',
			domain: 'tmt.example.com',
			scriptUrl: 'https://plausible.io/js/script.manual.js'
		});
	});

	it('rejects an http, credentialed or malformed script url and a bad domain', () => {
		const base = { ANALYTICS_PROVIDER: 'plausible', PLAUSIBLE_DOMAIN: 'tmt.example.com' };
		for (const url of [
			'http://stats.example.com/js/s.js',
			'https://user:pw@stats.example.com/s.js',
			'https://*.example.com/s.js',
			'javascript:alert(1)',
			'not a url'
		]) {
			expect(analyticsConfig({ ...base, PLAUSIBLE_SCRIPT_URL: url }), url).toBeNull();
		}
		expect(
			analyticsConfig({ ANALYTICS_PROVIDER: 'plausible', PLAUSIBLE_DOMAIN: 'bad domain; x' })
		).toBeNull();
	});

	it('umami needs a uuid website id and an https script url', () => {
		const ok = {
			ANALYTICS_PROVIDER: 'umami',
			UMAMI_WEBSITE_ID: UMAMI_ID,
			UMAMI_SCRIPT_URL: 'https://stats.example.com/script.js'
		};
		expect(analyticsConfig(ok)).toEqual({
			provider: 'umami',
			websiteId: UMAMI_ID,
			scriptUrl: 'https://stats.example.com/script.js'
		});
		expect(analyticsConfig({ ...ok, UMAMI_WEBSITE_ID: 'abc' })).toBeNull();
		expect(analyticsConfig({ ...ok, UMAMI_SCRIPT_URL: '' })).toBeNull();
		expect(
			analyticsConfig({ ...ok, UMAMI_SCRIPT_URL: 'http://stats.example.com/s.js' })
		).toBeNull();
	});

	it('cloudflare needs the 32-character token', () => {
		expect(
			analyticsConfig({ ANALYTICS_PROVIDER: 'cloudflare', CF_ANALYTICS_TOKEN: CF_TOKEN })
		).toEqual({ provider: 'cloudflare', token: CF_TOKEN });
		expect(
			analyticsConfig({ ANALYTICS_PROVIDER: 'cloudflare', CF_ANALYTICS_TOKEN: 'short' })
		).toBeNull();
	});

	it('problem messages never contain the configured values', () => {
		const msgs = analyticsProblems({
			ANALYTICS_PROVIDER: 'cloudflare',
			CF_ANALYTICS_TOKEN: 'super-secret-value'
		});
		expect(msgs.join(' ')).not.toContain('super-secret-value');
	});
});

describe('Do Not Track and Global Privacy Control', () => {
	const env = { ANALYTICS_PROVIDER: 'cloudflare', CF_ANALYTICS_TOKEN: CF_TOKEN };
	it('turns analytics off for DNT: 1 and Sec-GPC: 1', () => {
		expect(doNotTrack(new Headers({ dnt: '1' }))).toBe(true);
		expect(doNotTrack(new Headers({ 'sec-gpc': '1' }))).toBe(true);
		expect(doNotTrack(new Headers({ dnt: '0' }))).toBe(false);
		expect(analyticsForRequest(new Headers({ dnt: '1' }), env)).toBeNull();
		expect(analyticsForRequest(new Headers({ 'sec-gpc': '1' }), env)).toBeNull();
		expect(analyticsForRequest(new Headers(), env)).toEqual({
			provider: 'cloudflare',
			token: CF_TOKEN
		});
	});
});

describe('sanitizeAnalyticsPath', () => {
	it('keeps plain paths and drops query, hash and the trailing slash', () => {
		expect(sanitizeAnalyticsPath('/')).toBe('/');
		expect(sanitizeAnalyticsPath('/terms?utm=x#top')).toBe('/terms');
		expect(sanitizeAnalyticsPath('/workspace/')).toBe('/workspace');
	});

	it('replaces ids and slugs after builds, teams, designs, gallery and templates', () => {
		expect(sanitizeAnalyticsPath('/builds/abc123')).toBe('/builds/:id');
		expect(sanitizeAnalyticsPath('/builds/abc123/plates?x=1')).toBe('/builds/:id/plates');
		expect(sanitizeAnalyticsPath('/teams/my-secret-team/settings')).toBe('/teams/:id/settings');
		expect(sanitizeAnalyticsPath('/designs/blue-chair')).toBe('/designs/:id');
		expect(sanitizeAnalyticsPath('/gallery/red-one')).toBe('/gallery/:id');
		expect(sanitizeAnalyticsPath('/admin/templates/tpl_1')).toBe('/admin/templates/:id');
	});

	it('never reports api or invite paths', () => {
		for (const p of ['/api/health', '/api', '/invite/secret-id', '/invite', '/invite/x?y=1']) {
			expect(isAnalyticsExcluded(p), p).toBe(true);
			expect(sanitizeAnalyticsPath(p), p).toBeNull();
		}
		expect(isAnalyticsExcluded('/invitees')).toBe(false);
		expect(isAnalyticsExcluded('/apis')).toBe(false);
	});

	it('does not let a path trick keep an id', () => {
		expect(sanitizeAnalyticsPath('//builds//abc')).toBe('/builds/:id');
		expect(sanitizeAnalyticsPath('/builds/abc/../def')).toBe('/builds/:id/../def');
	});
});

describe('cloudflareMayReport (beacon cannot rewrite URLs)', () => {
	it('allows only pages without an id in the URL', () => {
		expect(cloudflareMayReport('/')).toBe(true);
		expect(cloudflareMayReport('/privacy')).toBe(true);
		expect(cloudflareMayReport('/builds/abc')).toBe(false);
		expect(cloudflareMayReport('/invite/abc')).toBe(false);
		expect(cloudflareMayReport('/api/x')).toBe(false);
		expect(cloudflareMayReport('/privacy?token=1')).toBe(false);
	});
});

describe('CSP origins', () => {
	it('adds only the chosen provider exact origins', () => {
		expect(analyticsCspSources(null)).toEqual({ scriptSrc: [], connectSrc: [] });
		expect(
			analyticsCspSources({
				provider: 'plausible',
				domain: 'a.example.com',
				scriptUrl: 'https://plausible.io/js/script.manual.js'
			})
		).toEqual({ scriptSrc: ['https://plausible.io'], connectSrc: ['https://plausible.io'] });
		expect(
			analyticsCspSources({
				provider: 'umami',
				websiteId: UMAMI_ID,
				scriptUrl: 'https://stats.example.com:8443/script.js'
			})
		).toEqual({
			scriptSrc: ['https://stats.example.com:8443'],
			connectSrc: ['https://stats.example.com:8443']
		});
		expect(analyticsCspSources({ provider: 'cloudflare', token: CF_TOKEN })).toEqual({
			scriptSrc: ['https://static.cloudflareinsights.com'],
			connectSrc: ['https://cloudflareinsights.com']
		});
	});
});

const KIT_CSP =
	"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'nonce-abc'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

describe('withExtraCspSources', () => {
	it('appends exact origins to script-src and connect-src and keeps everything else', () => {
		const csp = withExtraCspSources(KIT_CSP, {
			scriptSrc: ['https://plausible.io'],
			connectSrc: ['https://plausible.io']
		});
		expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'nonce-abc' https://plausible.io");
		expect(csp).toContain("connect-src 'self' https://plausible.io");
		expect(csp).toContain("style-src 'self' 'unsafe-inline'");
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		// script-src stays strict: no inline or wildcard allowance appears.
		const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
		expect(script).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
	});

	it('does not duplicate and ignores anything that is not a plain https origin', () => {
		const once = withExtraCspSources(KIT_CSP, {
			scriptSrc: ['https://a.example.com'],
			connectSrc: []
		});
		expect(
			withExtraCspSources(once, { scriptSrc: ['https://a.example.com'], connectSrc: [] })
		).toBe(once);
		const bad = withExtraCspSources(KIT_CSP, {
			scriptSrc: [
				'*',
				'https://*.example.com',
				"'unsafe-inline'",
				'http://x.example.com',
				'https://x.example.com/p',
				'https:'
			],
			connectSrc: ['data:', 'https://ok.example.com;script-src *']
		});
		expect(bad).toBe(KIT_CSP);
	});

	it('creates a missing directive', () => {
		expect(
			withExtraCspSources("default-src 'self'", {
				scriptSrc: [],
				connectSrc: ['https://a.example.com']
			})
		).toBe("default-src 'self'; connect-src https://a.example.com");
	});
});

describe('securityHeaders with analytics sources', () => {
	const base = {
		pathname: '/',
		https: true,
		contentType: 'text/html; charset=utf-8',
		hasCsp: true,
		existingCsp: KIT_CSP,
		extraSources: { scriptSrc: ['https://plausible.io'], connectSrc: ['https://plausible.io'] }
	};
	it('extends the page CSP of an HTML response', () => {
		expect(securityHeaders(base)['content-security-policy']).toContain('https://plausible.io');
	});
	it('leaves the CSP alone without extra sources', () => {
		expect(
			securityHeaders({ ...base, extraSources: undefined })['content-security-policy']
		).toBeUndefined();
	});
	it('never extends API or non-HTML responses', () => {
		const api = securityHeaders({ ...base, pathname: '/api/x', contentType: 'application/json' });
		expect(api['content-security-policy']).not.toContain('plausible');
		const json = securityHeaders({ ...base, contentType: 'application/json' });
		expect(json['content-security-policy']).toBeUndefined();
	});
});
