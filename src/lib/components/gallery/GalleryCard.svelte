<script lang="ts">
	import { resolve } from '$app/paths';
	import Swatch from '#lib/components/Swatch.svelte';
	import { sortRoles } from '#lib/domain/labels.ts';

	let {
		item
	}: {
		item: {
			id: string;
			slug: string;
			name: string;
			templateName: string;
			sharerName: string;
			roles: { key: string; name: string; hex: string }[];
			hasSnapshot: boolean;
			copies: number;
			mine: boolean;
		};
	} = $props();
	const href = $derived(resolve('/(app)/gallery/[slug]', { slug: item.slug }));
</script>

<li class="ds-card gal-card" data-gallery-design={item.slug}>
	<a class="gal-thumb" {href} tabindex="-1" aria-hidden="true">
		{#if item.hasSnapshot}
			<img src="/api/designs/{item.id}/snapshot.png" alt="" loading="lazy" />
		{:else}
			<span class="gal-strip">
				{#each sortRoles(item.roles, (r) => r.key) as r (r.key)}
					<span style="background:{r.hex}"></span>
				{/each}
			</span>
		{/if}
	</a>
	<div class="gal-meta">
		<h3><a {href}>{item.name}</a></h3>
		<div class="muted gal-by">
			By {item.sharerName}{#if item.mine}
				<span class="ds-badge ds-badge--sm">yours</span>{/if}
		</div>
		<div class="muted gal-by">
			{item.templateName} · used {item.copies}
			{item.copies === 1 ? 'time' : 'times'}
		</div>
	</div>
	<div class="gal-dots" role="img" aria-label="Colors: {item.roles.map((r) => r.name).join(', ')}">
		{#each sortRoles(item.roles, (r) => r.key) as r (r.key)}
			<Swatch hex={r.hex} size="mini" />
		{/each}
	</div>
</li>

<style>
	.gal-card {
		align-content: start;
		gap: var(--sp-5);
		padding: var(--sp-7);
	}
	.gal-card h3 {
		margin: 0;
		font-size: var(--fs-base);
		overflow-wrap: anywhere;
	}
	.gal-meta {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
	}
	.gal-by {
		font-size: var(--fs-md);
	}
	.gal-by .ds-badge {
		margin-left: var(--sp-3);
	}
	.gal-thumb {
		display: block;
		aspect-ratio: 4 / 3;
		border-radius: var(--r-lg);
		overflow: hidden;
		background: var(--paper);
		border: 1px solid var(--line);
	}
	.gal-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.gal-strip {
		display: flex;
		height: 100%;
	}
	.gal-strip span {
		flex: 1;
	}
	.gal-dots {
		display: flex;
		gap: var(--sp-3);
		flex-wrap: wrap;
	}
	@media (pointer: coarse) {
		.gal-card h3 a {
			display: inline-block;
			padding-block: var(--sp-6);
		}
	}
</style>
