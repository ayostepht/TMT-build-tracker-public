<script lang="ts">
	import { providerPhrase } from '#lib/sign-in-providers.ts';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const providerText = $derived(providerPhrase(data.signInProviders));
	let busy = $state(false);
	const siteKey = $derived(data.turnstileSiteKey);

	type TurnstileApi = {
		render: (el: HTMLElement, opts: Record<string, unknown>) => string;
		reset: (id?: string) => void;
	};
	let widgetEl = $state<HTMLElement>();
	let widgetId: string | undefined;
	let hasToken = $state(false);
	// The check could not load or errored (blocked script, network, widget error): offer a reload.
	let checkFailed = $state(false);

	const theme = () => {
		const set = document.documentElement.dataset.theme;
		if (set === 'light' || set === 'dark') return set;
		return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	};

	// Explicit render, managed mode: Cloudflare decides whether the visitor sees anything.
	onMount(() => {
		if (!siteKey) return;
		const w = window as unknown as { turnstile?: TurnstileApi };
		const fail = () => {
			hasToken = false;
			checkFailed = true;
		};
		const render = () => {
			if (!w.turnstile || !widgetEl || widgetId) return;
			try {
				widgetId = w.turnstile.render(widgetEl, {
					sitekey: siteKey,
					action: data.turnstileAction,
					theme: theme(),
					callback: () => {
						hasToken = true;
						checkFailed = false;
					},
					'expired-callback': () => (hasToken = false),
					'error-callback': () => {
						fail();
						return true;
					}
				});
			} catch {
				fail();
			}
		};
		// The script never loaded after a while (blocked by the page's CSP, offline): say so. A slow widget is not a failure.
		const timer = setTimeout(() => {
			if (!w.turnstile) fail();
		}, 8000);
		if (w.turnstile) render();
		else {
			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.onload = render;
			script.onerror = fail;
			document.head.appendChild(script);
		}
		return () => clearTimeout(timer);
	});

	const isBusy = $derived(data.busy || form?.busy === true);
</script>

<svelte:head>
	<title>Try the demo · TMT Build Tracker</title>
	<meta
		name="description"
		content="Try TMT Build Tracker with a sample chair build. No account needed; the demo is deleted after 24 hours."
	/>
</svelte:head>

<article class="demo-page">
	<header class="demo-head">
		<p class="demo-kicker">The demo</p>
		<h1>Track a sample chair build, no account needed</h1>
		<p class="demo-lede">
			You get your own private workspace with one build of the MakeGood 3D TMT already under way.
			Open it and do what a team does during a build: mark parts printed, log a failed print, start
			a plate, tick off assembly steps.
		</p>
	</header>

	<section class="demo-start" aria-label="Start the demo">
		{#if isBusy}
			<div class="demo-busy" role="status" data-testid="demo-busy">
				<h2>The demo is busy</h2>
				<p>
					A lot of people are trying it right now. Please come back in a little while, or
					<a href={resolve('/login')}>sign in</a> to use your own account.
				</p>
			</div>
		{:else if data.inDemo}
			<p>You already have a demo running.</p>
			<a class="btn primary go" href={resolve('/(app)/workspace')} data-testid="demo-continue"
				>Continue your demo</a
			>
		{:else}
			{#if form?.error}<div class="error" role="alert">{form.error}</div>{/if}
			<form
				method="post"
				action="?/start"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
						// A token works once: ask for a new one after every attempt.
						if (siteKey && widgetId) {
							hasToken = false;
							(window as unknown as { turnstile?: TurnstileApi }).turnstile?.reset(widgetId);
						}
					};
				}}
			>
				{#if siteKey}
					<div class="demo-challenge" bind:this={widgetEl} data-testid="demo-turnstile"></div>
					{#if checkFailed}
						<div class="demo-checkfail" role="status" data-testid="demo-turnstile-failed">
							<p>The bot check didn't load. Reload the page to try again.</p>
							<button type="button" class="btn" onclick={() => location.reload()}>Reload</button>
						</div>
					{/if}
				{/if}
				<button
					class="btn primary go"
					data-testid="demo-start"
					disabled={busy || (!!siteKey && !hasToken)}
				>
					{busy ? 'Setting up your demo…' : 'Start the demo'}
				</button>
			</form>
			<p class="demo-fine">
				Or <a href={resolve('/login')}>sign in</a>{providerText ? ` with ${providerText}` : ''} to keep
				your own builds.
			</p>
		{/if}
	</section>

	<section class="demo-body" aria-labelledby="demo-gets">
		<h2 id="demo-gets">What you get</h2>
		<ul class="demo-list">
			<li>
				<b>The tracking view first.</b> Every part and plate with its status: some printed, one plate
				printing now, a part waiting for a reprint, a couple of assembly steps done.
			</li>
			<li>
				<b>The whole path.</b> Print logs, filament used, the assembly checklist and the hand-off.
			</li>
			<li>
				<b>Colors, if you like.</b> Change the sample chair's colors and arrange parts onto plates.
			</li>
		</ul>
		<h2>What is switched off</h2>
		<p>
			No file uploads, no printers, no teams or invitations and no sharing, since there is nobody
			else in the demo. Everything else works.
		</p>
		<h2>What happens to it</h2>
		<p>
			The demo is yours alone and is <b>deleted after {data.hours} hours</b>, or when you sign out
			of it. Nothing moves to a real account: signing in later starts a fresh one. See the
			<a href={resolve('/(site)/privacy')}>Privacy</a> notes.
		</p>
	</section>
</article>

<style>
	.demo-checkfail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-4);
		margin-bottom: var(--sp-4);
	}
	.demo-page {
		width: min(46rem, 100%);
		margin: 0 auto;
		padding: 48px var(--sp-8) 0;
		display: grid;
		gap: 32px;
		min-width: 0;
	}
	.demo-page h1,
	.demo-page h2,
	.demo-page p {
		margin: 0;
	}
	.demo-head {
		display: grid;
		gap: var(--sp-5);
		padding-bottom: var(--sp-8);
		border-bottom: 1px solid var(--ink);
	}
	.demo-head h1 {
		font-size: clamp(34px, 8vw, var(--fs-4xl));
		line-height: 1;
		font-weight: 600;
	}
	.demo-kicker {
		font: 500 var(--fs-xs) / 1.3 var(--f-mono);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.demo-lede {
		font-size: var(--fs-lg);
		line-height: 1.55;
	}
	.demo-body {
		display: grid;
		gap: var(--sp-6);
		line-height: 1.55;
	}
	.demo-body h2 {
		font-size: var(--fs-xl);
		margin-top: var(--sp-4);
	}
	.demo-list {
		margin: 0;
		padding-left: 1.2em;
		display: grid;
		gap: var(--sp-4);
	}
	.demo-start {
		display: grid;
		gap: var(--sp-6);
		justify-items: start;
		padding: var(--sp-9);
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.demo-start .btn {
		min-height: 48px;
		font-weight: 600;
	}
	.demo-challenge {
		min-height: 65px;
		max-width: 100%;
	}
	.demo-start form {
		display: grid;
		gap: var(--sp-5);
		justify-items: start;
		max-width: 100%;
	}
	.demo-fine {
		font-size: var(--fs-md);
		color: var(--muted);
	}
	.demo-busy {
		display: grid;
		gap: var(--sp-4);
	}
	@media (max-width: 600px) {
		.demo-page {
			padding-top: var(--sp-8);
			gap: var(--sp-8);
		}
		.demo-start {
			padding: var(--sp-6);
			justify-items: stretch;
		}
		.demo-start form {
			justify-items: stretch;
		}
		.demo-start .btn.go {
			width: 100%;
			justify-content: center;
		}
	}
</style>
