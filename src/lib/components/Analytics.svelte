<script lang="ts">
	/**
	 * Cookieless page-view analytics. Renders nothing; loads the one provider the server chose
	 * (`ANALYTICS_PROVIDER`, see `src/lib/server/analytics.ts`) and reports a sanitized path
	 * on every navigation: no query string, ids and slugs after /builds/, /teams/, /designs/,
	 * /gallery/ replaced by `:id`, never /api/* or /invite/*. Nothing loads when the browser
	 * sends Do Not Track or Global Privacy Control, or when the layout data says analytics is off.
	 */
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { cloudflareMayReport, sanitizeAnalyticsPath } from '#lib/analytics-path.ts';

	type Config =
		| { provider: 'plausible'; domain: string; scriptUrl: string }
		| { provider: 'umami'; websiteId: string; scriptUrl: string }
		| { provider: 'cloudflare'; token: string };

	let { config }: { config: Config | null } = $props();

	type Win = Window & {
		plausible?: ((...args: unknown[]) => void) & { q?: unknown[][] };
		umami?: {
			track: (payload: (props: Record<string, unknown>) => Record<string, unknown>) => void;
		};
		globalPrivacyControl?: boolean;
		doNotTrack?: string;
	};

	let loaded = false;
	let umamiReady = false;

	/** The browser itself says "do not track". */
	function optedOut(): boolean {
		const w = window as Win;
		const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
		return nav.doNotTrack === '1' || w.doNotTrack === '1' || nav.globalPrivacyControl === true;
	}

	function load(c: Config) {
		const w = window as Win;
		const script = document.createElement('script');
		script.defer = true;
		if (c.provider === 'plausible') {
			// The manual variant: it reports nothing by itself, so only sanitized paths leave the page.
			w.plausible =
				w.plausible ||
				Object.assign(
					(...args: unknown[]) => {
						(w.plausible!.q = w.plausible!.q || []).push(args);
					},
					{ q: [] as unknown[][] }
				);
			script.src = c.scriptUrl;
			script.dataset.domain = c.domain;
		} else if (c.provider === 'umami') {
			script.src = c.scriptUrl;
			script.dataset.websiteId = c.websiteId;
			script.dataset.autoTrack = 'false';
			script.dataset.doNotTrack = 'true';
			script.addEventListener('load', () => {
				umamiReady = true;
				report(page.url.pathname);
			});
		} else {
			script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
			script.dataset.cfBeacon = JSON.stringify({ token: c.token });
		}
		document.head.append(script);
		loaded = true;
	}

	function report(pathname: string) {
		if (!config || !loaded) return;
		const path = sanitizeAnalyticsPath(pathname);
		if (path === null) return;
		const w = window as Win;
		if (config.provider === 'plausible') {
			w.plausible?.('pageview', { u: `${location.origin}${path}` });
		} else if (config.provider === 'umami' && umamiReady) {
			// Title and referrer would carry build names and full URLs: send the clean path instead.
			w.umami?.track((props) => ({ ...props, url: path, title: path, referrer: '' }));
		}
		// Cloudflare's beacon reports page loads by itself; see the guard in onMount.
	}

	onMount(() => {
		if (!config || optedOut()) return;
		// The beacon cannot rewrite URLs, so it only runs on a page whose URL has no id in it.
		if (config.provider === 'cloudflare' && !cloudflareMayReport(location.pathname)) return;
		load(config);
		report(page.url.pathname);
	});

	afterNavigate((nav) => {
		// The first (enter) navigation is reported from onMount, once the script is attached.
		if (nav.type === 'enter' || !loaded) return;
		report(nav.to?.url.pathname ?? page.url.pathname);
	});
</script>
