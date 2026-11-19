<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { copyGalleryDesign, unshareDesign } from '#lib/client/api.ts';
	import Dialog from '#lib/components/design/share/Dialog.svelte';
	import ModelStage from '#lib/components/design/ModelStage.svelte';
	import Swatch from '#lib/components/Swatch.svelte';
	import { filamentLabel, roleLabel, sortRoles } from '#lib/domain/labels.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const d = $derived(data.design);
	const item = $derived(data.item);

	const colors = $derived(
		Object.fromEntries(
			d.parts.flatMap((p) => {
				const r = d.roles.find((x) => x.key === p.role);
				return r ? [[p.slug, r.hex] as const] : [];
			})
		)
	);
	const bySlot = $derived(sortRoles(d.roles, (r) => r.key));

	let busy = $state(false);
	let error = $state<string | null>(null);
	let asking = $state(false);

	async function use() {
		error = null;
		busy = true;
		try {
			const c = await copyGalleryDesign(d.id);
			// The design page's own "use" card, where a build is started from the copy.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(resolve('/(app)/designs/[slug]', { slug: c.slug }) + '#use');
		} catch (e) {
			error = e instanceof Error ? e.message : 'That did not work.';
			busy = false;
		}
	}

	async function stop() {
		error = null;
		busy = true;
		try {
			await unshareDesign(d.id);
			asking = false;
			await goto(resolve('/(app)/gallery'));
		} catch (e) {
			asking = false;
			error = e instanceof Error ? e.message : 'That did not work.';
			busy = false;
		}
	}
</script>

<svelte:head><title>{d.name} · Gallery · TMT Build Tracker</title></svelte:head>

<section class="gd-page">
	<a class="btn ghost sm back" href={resolve('/(app)/gallery')}
		><span class="btn-arrow" aria-hidden="true">←</span> Gallery</a
	>
	<div class="gd-top">
		<div class="gd-titles">
			<div class="kicker">{item.templateName}</div>
			<h1>{d.name}</h1>
			<p class="muted">
				Shared by {item.sharerName} · used {item.copies}
				{item.copies === 1 ? 'time' : 'times'}
			</p>
		</div>
		<button
			class="btn primary gd-use"
			data-testid="use-gallery-design"
			disabled={busy}
			onclick={use}>Use this design</button
		>
	</div>

	{#if error}<div class="error" role="alert">{error}</div>{/if}

	<div class="gd-cols">
		<div class="gd-stage">
			{#if data.model}
				<ModelStage
					model={data.model}
					{colors}
					hidden={data.hidden}
					siteAdmin={false}
					label="Design preview"
				/>
			{:else if d.hasSnapshot}
				<img class="gd-snap" src="/api/designs/{d.id}/snapshot.png" alt="Preview of {d.name}" />
			{:else}
				<ModelStage model={null} {colors} siteAdmin={false} />
			{/if}
		</div>
		<div class="gd-side">
			<section class="ds-card">
				<h2>Filaments</h2>
				<ul class="gd-slots">
					{#each bySlot as r (r.key)}
						<li data-role={r.key}>
							<Swatch hex={r.hex} tpu={/^tp/i.test(r.material)} />
							<span class="gd-txt">
								<b>{roleLabel(r.key, r)}</b>
								<span class="muted">{filamentLabel(r, r.key)} · {r.hex}</span>
							</span>
						</li>
					{/each}
				</ul>
			</section>
			<section class="ds-card">
				<h2>Use it</h2>
				<p class="muted">
					"Use this design" saves your own private copy. Then start a build from it, or copy its
					colors into a build you already have. Changes you make never affect the original, and it
					keeps working if the original is removed.
				</p>
				<div class="gd-acts">
					<button class="btn primary" disabled={busy} onclick={use}>Use this design</button>
					{#if item.mine}
						<button class="btn" disabled={busy} onclick={() => (asking = true)}>Stop sharing</button
						>
					{:else if data.siteAdmin}
						<button
							class="btn danger"
							disabled={busy}
							onclick={() => (asking = true)}
							data-testid="hide-from-gallery">Hide from the gallery</button
						>
					{/if}
				</div>
			</section>
		</div>
	</div>
</section>

{#if asking}
	<Dialog
		title={item.mine ? 'Stop sharing?' : 'Hide from the gallery?'}
		onclose={() => (asking = false)}
		testid="unshare-dialog"
		danger
	>
		<div class="gd-confirm">
			<p>
				{item.mine
					? `"${d.name}" will leave the gallery. Copies other makers already saved stay with them.`
					: `"${d.name}" will leave the gallery for everyone. Copies already saved stay with those makers.`}
			</p>
			<div class="gd-acts">
				<button class="btn" type="button" data-cancel onclick={() => (asking = false)}
					>Cancel</button
				>
				<button class="btn danger" type="button" disabled={busy} onclick={stop}>
					{item.mine ? 'Stop sharing' : 'Hide it'}
				</button>
			</div>
		</div>
	</Dialog>
{/if}

<style>
	.gd-page {
		display: grid;
		gap: var(--sp-8);
		min-width: 0;
	}
	h1,
	h2,
	p {
		margin: 0;
	}
	.gd-top {
		display: flex;
		gap: var(--sp-6);
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.gd-titles {
		display: grid;
		gap: var(--sp-2);
		min-width: 0;
	}
	.gd-titles h1 {
		overflow-wrap: anywhere;
	}
	.gd-use {
		min-height: 44px;
		padding-inline: var(--sp-9);
	}
	.gd-cols {
		display: grid;
		gap: var(--sp-8);
		grid-template-columns: minmax(0, 1fr);
		align-items: start;
	}
	.gd-stage {
		height: 55vh;
		min-height: 260px;
	}
	.gd-snap {
		width: 100%;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
	}
	.gd-side {
		display: grid;
		gap: var(--sp-7);
		min-width: 0;
	}
	.gd-slots {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--sp-6);
	}
	.gd-slots li {
		display: flex;
		gap: var(--sp-5);
		align-items: flex-start;
	}
	.gd-txt {
		display: grid;
		min-width: 0;
		gap: 1px;
		overflow-wrap: anywhere;
	}
	.gd-acts {
		display: flex;
		gap: var(--sp-4);
		flex-wrap: wrap;
	}
	.gd-confirm {
		display: grid;
		gap: var(--sp-6);
	}
	@media (min-width: 900px) {
		.gd-cols {
			grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr);
		}
		.gd-stage {
			height: min(70vh, 680px);
		}
	}
</style>
