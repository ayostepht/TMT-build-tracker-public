<script lang="ts">
	import { resolve } from '$app/paths';

	/** `endsAt`: ISO time the demo is deleted. */
	let { endsAt }: { endsAt: string } = $props();

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
	<a class="btn sm primary" href={resolve('/login')} data-testid="demo-sign-in">Sign in</a>
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
	.demo-banner p {
		margin: 0;
		font-size: var(--fs-md);
		line-height: 1.4;
	}
</style>
