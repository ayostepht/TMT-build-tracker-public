<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Teams · TMT Build Tracker</title></svelte:head>

<section class="stack narrow">
	<div class="kicker">Teams</div>
	<h1>Build with others</h1>
	<p class="muted">
		A team is a group of makers who share builds, progress and filament. Your own builds stay in My
		builds until you move them to a team.
	</p>

	{#if data.invitations.length}
		<div class="card stack">
			<h2>Invitations for you</h2>
			{#each data.invitations as i (i.id)}
				<div>
					<b>{i.team}</b> invited you as {i.role} (from {i.inviter}).
					<a class="btn primary" href={resolve('/invite/[id]', { id: i.id })}>View invitation</a>
				</div>
			{/each}
		</div>
	{/if}

	<form class="card stack" method="post" action="?/create" use:enhance>
		<h2>Create a team</h2>
		{#if form?.error}<div class="error" role="alert">{form.error}</div>{/if}
		<label class="field">Team name<input name="name" required maxlength="80" /></label>
		<button class="btn primary">Create team</button>
	</form>

	<p>
		<a class="btn ghost sm back" href={resolve('/(app)/workspace')}
			><span class="btn-arrow" aria-hidden="true">←</span> Back to my builds</a
		>
	</p>
</section>
