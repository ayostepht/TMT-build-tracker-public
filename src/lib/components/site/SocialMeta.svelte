<script lang="ts">
	import { page } from '$app/state';

	/**
	 * Title, description, canonical link and the Open Graph / Twitter card tags for a public page.
	 * Link previews (Messages, Slack, Discord, Facebook) read these from the server-rendered HTML.
	 * The origin is the configured public one (the site layout's load), else the request's own.
	 */
	let {
		title,
		description,
		path = page.url.pathname
	}: {
		title: string;
		description: string;
		/** the canonical path of this page, default the current one */
		path?: string;
	} = $props();

	const origin = $derived((page.data as { siteOrigin?: string }).siteOrigin ?? page.url.origin);
	const url = $derived(origin + (path === '/' ? '/' : path));
	const image = $derived(`${origin}/og.png`);
	const imageAlt =
		'TMT Build Tracker: the MakeGood 3D TMT chair in teal and ochre on a warm paper background.';
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="TMT Build Tracker" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={imageAlt} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content={imageAlt} />
</svelte:head>
