<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const slug = $derived(data.team.slug);
	/** After leaving or deleting a team, /workspace lands here with a fixed notice code. */
	const NOTICES: Record<string, string> = {
		left: 'You left the team.',
		deleted: 'The team was deleted.'
	};
	const notice = $derived(NOTICES[page.url.searchParams.get('notice') ?? ''] ?? null);
	const tabs = $derived([
		{ label: 'Builds', href: resolve('/(app)/teams/[slug]', { slug }) },
		...(data.team.personal
			? []
			: [{ label: 'Members', href: resolve('/(app)/teams/[slug]/members', { slug }) }]),
		{ label: 'Printers', href: resolve('/(app)/teams/[slug]/printers', { slug }) },
		{ label: 'Stats', href: resolve('/(app)/teams/[slug]/stats', { slug }) },
		{ label: 'Integrations', href: resolve('/(app)/teams/[slug]/integrations', { slug }) }
	]);
</script>

<svelte:head><title>{data.team.name} · TMT Build Tracker</title></svelte:head>

<section class="stack">
	{#if notice}<div class="card" role="status" data-testid="team-notice">{notice}</div>{/if}
	<div class="kicker">{data.team.personal ? 'Just you' : `Team (${data.role})`}</div>
	<h1>{data.team.name}</h1>
	<nav class="tabs" aria-label="Team sections">
		{#each tabs as t (t.href)}
			<a href={t.href} aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a
			>
		{/each}
	</nav>
	{@render children()}
</section>
