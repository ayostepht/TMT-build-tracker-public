<script lang="ts">
	import SiteHeader from '#lib/components/site/SiteHeader.svelte';
	import SiteFooter from '#lib/components/site/SiteFooter.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="site">
	<SiteHeader signedIn={data.signedIn} />
	<main id="main" tabindex="-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>

<style>
	.site {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow-x: clip;
	}
	main {
		flex: 1;
		width: 100%;
		min-width: 0;
	}
</style>
