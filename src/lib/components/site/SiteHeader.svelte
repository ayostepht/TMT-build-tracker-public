<script lang="ts">
	import { resolve } from '$app/paths';
	import AppMark from '#lib/components/AppMark.svelte';

	let { signedIn = false }: { signedIn?: boolean } = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<header class="site-head">
	<div class="site-head__in">
		<a class="site-head__brand" href={resolve('/(site)')} aria-label="TMT Build Tracker, home">
			<AppMark size={28} />
			<span>TMT Build Tracker</span>
		</a>
		<nav class="site-head__nav" aria-label="Site">
			{#if signedIn}
				<a class="btn primary" href={resolve('/(app)/workspace')}>Open your builds</a>
			{:else}
				<a class="site-head__link" href="/demo">Try the demo</a>
				<a class="btn" href={resolve('/login')}>Sign in</a>
			{/if}
		</nav>
	</div>
</header>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
	.site-head {
		border-bottom: 1px solid var(--line);
		background: var(--paper);
	}
	.site-head__in {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--sp-6) var(--sp-8);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-8);
		min-width: 0;
	}
	.site-head__brand {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-5);
		min-width: 0;
		color: var(--ink);
		text-decoration: none;
		font: 700 var(--fs-xl) / 1 var(--f-display);
		letter-spacing: 0.02em;
		min-height: 44px;
	}
	.site-head__brand span {
		white-space: nowrap;
	}
	.site-head__nav {
		display: flex;
		align-items: center;
		gap: var(--sp-8);
	}
	.site-head__link {
		color: var(--ink);
		font-weight: 500;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
	}
	@media (max-width: 380px) {
		.site-head__brand span {
			font-size: var(--fs-lg);
		}
		.site-head__nav {
			gap: var(--sp-5);
		}
	}
</style>
