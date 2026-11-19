<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';

	/** Terms and privacy text, set as a plain editorial column inside the public site layout (which supplies <main>). */
	let {
		title,
		updated,
		signedIn,
		other,
		children
	}: {
		title: string;
		/** ISO date the text was last changed. */
		updated: string;
		signedIn: boolean;
		/** The sibling page, linked at the foot. */
		other: 'privacy' | 'terms';
		children: Snippet;
	} = $props();
</script>

<article class="legal-page">
	<header class="legal-head">
		<p class="legal-kicker">TMT Build Tracker</p>
		<h1>{title}</h1>
		<p class="legal-updated">Last updated <time datetime={updated}>{updated}</time></p>
	</header>
	<div class="legal-body">{@render children()}</div>
	<footer class="legal-foot">
		{#if signedIn}
			<a class="btn primary" href={resolve('/(app)/workspace')} data-testid="legal-back"
				>Back to the app</a
			>
		{:else}
			<a class="btn primary" href={resolve('/login')} data-testid="legal-back">Sign in</a>
		{/if}
		{#if other === 'privacy'}
			<a class="btn" href={resolve('/(site)/privacy')} data-testid="privacy-link">Privacy</a>
		{:else}
			<a class="btn" href={resolve('/(site)/terms')} data-testid="terms-link">Terms</a>
		{/if}
	</footer>
</article>

<style>
	.legal-page {
		width: min(46rem, 100%);
		margin: 0 auto;
		padding: 48px var(--sp-8) 0;
		display: grid;
		gap: 40px;
		min-width: 0;
	}
	.legal-head {
		display: grid;
		gap: var(--sp-5);
		padding-bottom: var(--sp-8);
		border-bottom: 1px solid var(--ink);
	}
	.legal-head p {
		margin: 0;
	}
	.legal-head h1 {
		font-size: clamp(var(--fs-3xl), 8vw, var(--fs-4xl));
		line-height: 1;
	}
	.legal-kicker,
	.legal-updated {
		font: 500 var(--fs-xs) / 1.3 var(--f-mono);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.legal-body {
		display: grid;
		gap: var(--sp-7);
		min-width: 0;
		overflow-wrap: anywhere;
		line-height: 1.65;
		max-width: var(--measure);
	}
	.legal-body :global(h2) {
		margin: var(--sp-10) 0 0;
		padding-top: var(--sp-6);
		border-top: 1px solid var(--line);
		font-size: var(--fs-xl);
	}
	.legal-body :global(p),
	.legal-body :global(ul) {
		margin: 0;
	}
	.legal-body :global(ul) {
		padding-left: 1.25em;
		display: grid;
		gap: var(--sp-4);
	}
	.legal-foot {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-5);
	}
</style>
