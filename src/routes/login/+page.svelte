<script lang="ts">
	import { resolve } from '$app/paths';
	import { authClient } from '#lib/auth-client.ts';
	import ProviderMark from '#lib/components/demo/ProviderMark.svelte';
	import SiteFooter from '#lib/components/site/SiteFooter.svelte';
	import SiteHeader from '#lib/components/site/SiteHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let busy = $state<string | null>(null);
	let error = $state('');

	const NAMES = { google: 'Google', github: 'GitHub', discord: 'Discord' } as const;

	// Failed round trips come back to this page with ?error=<code>.
	const errorBack = $derived(
		data.redirectTo ? `/login?redirect=${encodeURIComponent(data.redirectTo)}` : '/login'
	);

	async function signIn(provider: 'google' | 'github' | 'discord') {
		busy = provider;
		error = '';
		// redirectTo is validated server-side (same-origin relative path only)
		const res = await authClient.signIn.social({
			provider,
			callbackURL: data.redirectTo ?? '/workspace',
			errorCallbackURL: errorBack
		});
		// On success the browser is already on its way to the provider.
		if (res?.error) {
			error = res.error.message ?? 'Sign-in did not start. Please try again.';
			busy = null;
		}
	}
</script>

<svelte:head><title>Sign in · TMT Build Tracker</title></svelte:head>

<div class="login-page">
	<SiteHeader signedIn={false} />
	<main id="main" tabindex="-1" class="login-main">
		<section class="login-card" aria-labelledby="login-h">
			<p class="login-kicker">TMT Build Tracker</p>
			<h1 id="login-h">Sign in</h1>
			<p class="login-lede">
				Keep one chair's build in one place: every part, every plate, from printed to assembled to
				handed off, shared with your team.
			</p>

			{#if data.notice}<p class="login-note" role="status">{data.notice}</p>{/if}
			{#if error}<div class="error" role="alert">{error}</div>{/if}
			{#if data.authError}<div class="error" role="alert" data-testid="auth-error">
					{data.authError}
				</div>{/if}
			{#if data.inDemo}
				<p class="login-note" role="status">
					You are in the demo. Signing in starts a fresh account; nothing from the demo moves over.
				</p>
			{/if}
			{#if data.accountsPaused}
				<p class="login-note" role="status" data-testid="accounts-paused">
					This server is not taking new accounts right now. You can still sign in if you already
					have one.
				</p>
			{/if}

			<div class="login-buttons">
				{#each data.providers as p (p)}
					<button
						type="button"
						class="btn login-provider"
						data-testid={`sign-in-${p}`}
						disabled={busy !== null}
						onclick={() => signIn(p)}
					>
						<ProviderMark provider={p} />
						<span>Continue with {NAMES[p]}</span>
					</button>
				{:else}
					<p class="login-note" data-testid="no-providers">
						Sign-in is not set up on this server yet.
					</p>
				{/each}
			</div>

			<p class="login-fine">
				Signing in creates your account if you do not have one. We store your name, email address,
				picture address and your provider's account id, nothing else from it.
			</p>
			<p class="login-demo">
				Want a look around first? <a
					href={resolve('/(site)/demo')}
					data-sveltekit-reload
					data-testid="try-demo">Try the demo instead</a
				>. No account needed.
			</p>
			<p class="login-fine">
				By signing in you agree to the <a href={resolve('/(site)/terms')} data-testid="terms-link"
					>Terms</a
				>
				and the <a href={resolve('/(site)/privacy')} data-testid="privacy-link">Privacy</a> notes.
			</p>
		</section>
	</main>
	<SiteFooter />
</div>

<style>
	.login-page {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow-x: clip;
	}
	.login-main {
		flex: 1;
		width: 100%;
		min-width: 0;
		padding: 40px var(--sp-8) 0;
		display: flex;
		justify-content: center;
		align-items: flex-start;
	}
	.login-card {
		width: min(30rem, 100%);
		display: grid;
		gap: var(--sp-7);
		padding: var(--sp-10, 24px);
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 8px;
		min-width: 0;
	}
	.login-card h1 {
		margin: 0;
		font-size: var(--fs-3xl);
		line-height: 1;
	}
	.login-card p {
		margin: 0;
	}
	.login-kicker {
		font: 500 var(--fs-xs) / 1.3 var(--f-mono);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.login-lede {
		font-size: var(--fs-lg);
		line-height: 1.5;
	}
	.login-buttons {
		display: grid;
		gap: var(--sp-5);
	}
	.login-provider {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-5);
		min-height: 48px;
		width: 100%;
		font-weight: 600;
	}
	.login-note {
		color: var(--muted);
	}
	.login-fine {
		font-size: var(--fs-md);
		color: var(--muted);
		line-height: 1.5;
	}
	.login-demo {
		font-size: var(--fs-base);
	}
</style>
