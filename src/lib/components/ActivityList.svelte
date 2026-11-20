<script lang="ts">
	import { resolve } from '$app/paths';
	import { describeActivitySegments } from '#lib/domain/activity.ts';
	import { getBuildCtx, ago } from './build-context.svelte.ts';

	// limit: entries shown (the server loads at most 50). heading: null hides the heading
	// (the Activity tab already says "Activity").
	let { limit = 12, heading = 'Recent activity' }: { limit?: number; heading?: string | null } =
		$props();

	const ctx = getBuildCtx();
	const shown = $derived(ctx.view.activity.slice(0, limit));
	// The view is capped server-side, so a full list may have older entries we never loaded.
	const truncated = $derived(ctx.view.activity.length >= 50 && limit >= 50);

	// Links go to this build's Print tab; the Print tab reads the hash (#plate-N / #part-slug).
	const printUrl = $derived(resolve('/(app)/builds/[id]/print', { id: ctx.id }));

	// A shortened note opens to its full text on tap (a hover title does nothing on a phone).
	let opened = $state<Record<string, boolean>>({});
</script>

<section
	aria-labelledby={heading ? 'actTitle' : undefined}
	aria-label={heading ? undefined : 'Activity'}
	style="display:grid;gap:var(--sp-5)"
>
	{#if heading}<h2 id="actTitle">{heading}</h2>{/if}
	{#if ctx.view.activity.length}
		<ul class="activity">
			{#each shown as a (a.id)}
				<li>
					<span class="atext"
						>{#each describeActivitySegments(a, ctx.view) as s, i (i)}{#if s.plate !== undefined}<a
									class="alink"
									href="{printUrl}#plate-{s.plate}">{s.text}</a
								>{:else if s.part}<a class="alink" href="{printUrl}#part-{s.part}">{s.text}</a
								>{:else if s.full}<button
									type="button"
									class="anote"
									title={s.full}
									aria-expanded={!!opened[a.id + i]}
									onclick={() => (opened[a.id + i] = !opened[a.id + i])}
									>{opened[a.id + i] ? s.full : s.text}</button
								>{:else}{s.text}{/if}{/each}</span
					><time datetime={a.at}>{ago(a.at, ctx.now)}</time>
				</li>
			{/each}
		</ul>
		{#if truncated}
			<p class="empty" data-testid="activity-truncated">
				Showing the last {ctx.view.activity.length} changes. Older changes aren't shown.
			</p>
		{/if}
	{:else}
		<p class="empty">Nothing yet. Changes on this build show up here.</p>
	{/if}
</section>

<style>
	.atext {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.anote {
		border: 0;
		background: none;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		overflow-wrap: anywhere;
	}
	/* Phones: rows are at least 44px tall and the in-row links get a taller hit area without moving the text. */
	@media (pointer: coarse), (max-width: 760px) {
		.activity li {
			align-items: center;
			min-height: 44px;
			box-sizing: border-box;
		}
		.alink,
		.anote {
			display: inline-block;
			padding-block: 12px;
			margin-block: -12px;
		}
	}
</style>
