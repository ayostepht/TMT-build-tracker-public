<script lang="ts">
	import { providerPhrase } from '#lib/sign-in-providers.ts';
	import AppMark from '#lib/components/AppMark.svelte';
	import { authClient } from '#lib/auth-client.ts';
	import { clearPrivateCaches } from '#lib/client/pwa.ts';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const providerText = $derived(providerPhrase(data.signInProviders));
	const back = $derived(encodeURIComponent(`/invite/${data.invitation.id}`));
	let leaving = $state(false);

	/** Sign out, then come back to this invite (the sign-in page returns here). */
	async function useAnotherAccount() {
		leaving = true;
		try {
			await authClient.signOut();
			await clearPrivateCaches().catch(() => {});
			await invalidateAll();
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(`/login?redirect=${back}`);
		} finally {
			leaving = false;
		}
	}
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
			<div class="actions">
				{#if data.isMember && data.invitation.slug}
					<a
						class="btn primary"
						data-testid="invite-go-team"
						href={resolve('/(app)/teams/[slug]', { slug: data.invitation.slug })}>Go to the team</a
					>
				{:else if data.signedIn}
					<a class="btn" href={resolve('/(app)/workspace')}>Go to my builds</a>
				{:else}
					<a class="btn" href={resolve('/(site)')}>Go to the home page</a>
				{/if}
			</div>
		{:else if !data.signedIn}
			<p class="muted">
				Sign in with the {providerText ? `${providerText} ` : ''}account that uses the invited email
				address. You come back to this page afterwards.
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
				You are signed in as {data.userEmail}, but this invitation was sent to
				{#if data.invitation.maskedEmail}<span data-testid="invite-masked-email"
						>{data.invitation.maskedEmail}</span
					>{:else}a different address{/if}.
			</div>
			<div class="actions">
				<button
					type="button"
					class="btn primary"
					data-testid="invite-switch-account"
					disabled={leaving}
					onclick={useAnotherAccount}>Sign out and use another account</button
				>
				<a class="btn" href={resolve('/(app)/workspace')}>Go to my builds</a>
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.auth-brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
