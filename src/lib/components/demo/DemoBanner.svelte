<script lang="ts">
	import { resolve } from '$app/paths';

	/** `endsAt`: ISO time the demo is deleted. `onleave`: signs out (which deletes the demo). */
	let { endsAt, onleave }: { endsAt: string; onleave: () => Promise<void> } = $props();

	let confirming = $state(false);
	let leaving = $state(false);
	async function leave() {
		leaving = true;
		try {
			await onleave();
		} finally {
			leaving = false;
		}
	}

	const hours = $derived(
		Math.max(1, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 3_600_000))
	);
	const label = $derived(hours === 1 ? '1 hour' : `${hours} hours`);
</script>

<div class="demo-banner" role="region" aria-label="Demo" data-testid="demo-banner">
	<p>
		<b>You're in a demo.</b>
		It's deleted in {label}. Sign in to keep your own builds.
	</p>
	<div class="demo-banner__actions">
		{#if confirming}
			<span class="demo-banner__ask" role="alert">Delete the demo and everything in it?</span>
			<button
				type="button"
				class="btn sm"
				disabled={leaving}
				onclick={leave}
				data-testid="demo-leave-confirm">Yes, delete it</button
			>
			<button type="button" class="btn sm ghost" onclick={() => (confirming = false)}
				>Keep it</button
			>
		{:else}
			<a class="btn sm primary" href={resolve('/login')} data-testid="demo-sign-in">Sign in</a>
			<button
				type="button"
				class="btn sm"
				onclick={() => (confirming = true)}
				data-testid="demo-leave">Leave the demo</button
			>
		{/if}
	</div>
</div>

<style>
	.demo-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--sp-4) var(--sp-8);
		padding: var(--sp-5) var(--sp-8);
		background: var(--accent-soft);
		border-bottom: 1px solid var(--accent);
		color: var(--ink);
	}
	.demo-banner__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--sp-4);
	}
	.demo-banner__ask {
		font-size: var(--fs-md);
		font-weight: 600;
	}
	.demo-banner p {
		margin: 0;
		font-size: var(--fs-md);
		line-height: 1.4;
	}
</style>
