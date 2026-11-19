<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import GalleryCard from '#lib/components/gallery/GalleryCard.svelte';
	import { COLOR_FAMILIES } from '#lib/domain/swatch-picker.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const g = $derived(data.gallery);

	let q = $derived(data.q);

	function href(next: { q?: string; family?: string; page?: number }): string {
		const sp = new SvelteURLSearchParams();
		const nq = next.q ?? data.q;
		const nf = next.family ?? data.family;
		if (nq) sp.set('q', nq);
		if (nf) sp.set('family', nf);
		if (next.page && next.page > 1) sp.set('page', String(next.page));
		const s = sp.toString();
		return `${resolve('/(app)/gallery')}${s ? `?${s}` : ''}`;
	}
	// Same page, only the query string changes.
	// eslint-disable-next-line svelte/no-navigation-without-resolve
	const go = (u: string) => goto(u);
	const filtered = $derived(!!data.q || !!data.family);
</script>

<svelte:head><title>Gallery · TMT Build Tracker</title></svelte:head>

<!-- The links below are the gallery path plus a query string, built by href(). -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<section class="gal-page">
	<div class="gal-head">
		<div class="kicker">Shared color designs</div>
		<h1>Gallery</h1>
		<p class="muted gal-lead">
			Color schemes other makers chose to share. Open one to see it on the chair, then use it: you
			get your own copy to start a build from or tweak.
		</p>
	</div>

	<form
		class="gal-filters"
		role="search"
		onsubmit={(e) => {
			e.preventDefault();
			void go(href({ q: q.trim(), page: 1 }));
		}}
	>
		<input
			type="search"
			name="q"
			placeholder="Search by name"
			aria-label="Search the gallery by name"
			maxlength="100"
			bind:value={q}
		/>
		<button class="btn" type="submit">Search</button>
		{#if filtered}
			<a class="btn ghost" href={resolve('/(app)/gallery')} data-sveltekit-keepfocus>Clear</a>
		{/if}
		<span class="muted gal-count" aria-live="polite"
			>{g.total} design{g.total === 1 ? '' : 's'}</span
		>
	</form>
	<div class="gal-fam" role="group" aria-label="Filter by color">
		<a
			class="ds-badge"
			href={href({ family: '', page: 1 })}
			aria-current={!data.family ? 'true' : undefined}>All colors</a
		>
		{#each COLOR_FAMILIES as f (f.id)}
			<a
				class="ds-badge"
				href={href({ family: f.id, page: 1 })}
				aria-current={data.family === f.id ? 'true' : undefined}>{f.label}</a
			>
		{/each}
	</div>

	{#if g.items.length}
		<ul class="gal-grid">
			{#each g.items as item (item.id)}
				<GalleryCard {item} model={data.models[item.templateId] ?? null} />
			{/each}
		</ul>
		{#if g.pages > 1}
			<nav class="gal-pager" aria-label="Pages">
				{#if g.page > 1}
					<a class="btn" rel="prev" href={href({ page: g.page - 1 })}>Previous</a>
				{/if}
				<span class="muted">Page {g.page} of {g.pages}</span>
				{#if g.page < g.pages}
					<a class="btn" rel="next" href={href({ page: g.page + 1 })}>Next</a>
				{/if}
			</nav>
		{/if}
	{:else}
		<div class="ds-card ds-card--dashed gal-empty" data-testid="gallery-empty">
			{#if filtered}
				<h2>Nothing matches</h2>
				<p class="muted">Try another name or color, or clear the filters.</p>
			{:else}
				<h2>No designs have been shared yet</h2>
				<p class="muted">
					To share yours, open a design in
					<a href={resolve('/(app)/designs')}>Designs</a>
					(or save one from a build's Design tab first), then choose "Share to the gallery". You can stop
					sharing at any time.
				</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.gal-page {
		display: grid;
		gap: var(--sp-8);
		min-width: 0;
	}
	h1,
	h2,
	p {
		margin: 0;
	}
	.gal-head {
		display: grid;
		gap: var(--sp-3);
	}
	.gal-lead {
		max-width: 62ch;
	}
	.gal-filters {
		display: flex;
		gap: var(--sp-5);
		flex-wrap: wrap;
		align-items: center;
	}
	.gal-filters input {
		flex: 1 1 200px;
		min-width: 0;
		max-width: 420px;
		min-height: 40px;
		padding: var(--sp-4) var(--sp-5);
		border: 1px solid var(--field-line);
		border-radius: var(--r-md);
		background: var(--card);
		color: var(--ink);
		font-size: var(--fs-base);
	}
	@media (pointer: coarse) {
		.gal-filters input {
			font-size: var(--fs-field);
			min-height: 44px;
		}
	}
	.gal-count {
		font-size: var(--fs-md);
		margin-left: auto;
	}
	.gal-fam {
		display: flex;
		gap: var(--sp-3);
		flex-wrap: wrap;
	}
	.gal-fam a[aria-current='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.gal-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--sp-7);
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
	}
	.gal-pager {
		display: flex;
		gap: var(--sp-6);
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
	}
	.gal-empty {
		max-width: 62ch;
	}
</style>
