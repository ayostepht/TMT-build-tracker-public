<script lang="ts">
	import AppMark from '#lib/components/AppMark.svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const back = $derived(encodeURIComponent(`/invite/${data.invitation.id}`));
</script>

<svelte:head><title>Join {data.invitation.team} · TMT Build Tracker</title></svelte:head>

<main id="main" class="wrap" tabindex="-1">
	<div class="card auth">
		<div>
			<div class="kicker auth-brand"><AppMark size={24} />TMT Build Tracker</div>
			<h1>Join {data.invitation.team}</h1>
		</div>
		<p>
			{data.invitation.inviter} invited you to join <b>{data.invitation.team}</b> as
			<b>{data.invitation.role}</b>.
		</p>
		{#if form?.error}<div class="error" role="alert">{form.error}</div>{/if}

		{#if data.invitation.status !== 'pending'}
			<p class="muted">This invitation is {data.invitation.status}.</p>
		{:else if !data.signedIn}
			<p class="muted">
				Sign in with the Google, GitHub or Discord account that uses the invited email address. You
				come back to this page afterwards.
			</p>
			<a class="btn primary" href={resolve(`/login?redirect=${back}`)}>Sign in</a>
		{:else if data.isDemo}
			<div class="error" role="alert">
				You are in the demo, which cannot join teams. Sign in with your own account to accept this
				invitation.
			</div>
			<a class="btn primary" href={resolve(`/login?redirect=${back}`)}>Sign in</a>
		{:else if data.needsVerifiedEmail}
			<div class="error" role="alert">
				Your email address is not verified by your sign-in provider, so this invitation cannot be
				accepted.
			</div>
		{:else if data.wrongAccount}
			<div class="error" role="alert">
				You are signed in as {data.userEmail}, but this invitation was sent to a different address.
			</div>
		{:else}
			<form method="post" action="?/accept" use:enhance>
				<button class="btn primary">Accept</button>
			</form>
			<form method="post" action="?/decline" use:enhance>
				<button class="btn">Decline</button>
			</form>
		{/if}
	</div>
</main>

<style>
	.auth-brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
