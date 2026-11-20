<script lang="ts">
	import { resolve } from '$app/paths';
	import { MAKEGOOD_MODEL_URL } from '#lib/makegood.ts';
	import { FEEDBACK_URL, REPO_URL } from '#lib/repo.ts';
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<footer class="site-foot">
	<div class="site-foot__in">
		<div class="site-foot__credit">
			<p class="site-foot__mono">
				3D model and print files: <a
					href={MAKEGOOD_MODEL_URL}
					target="_blank"
					rel="noopener noreferrer">MakeGood</a
				> · CC0
			</p>
			<p class="site-foot__small">
				TMT Build Tracker is an independent, open source project. It is not made or endorsed by
				MakeGood.
			</p>
		</div>
		<nav class="site-foot__links" aria-label="Footer">
			<a href={resolve('/(site)/privacy')}>Privacy</a>
			<a href={resolve('/(site)/terms')}>Terms</a>
			<a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
			<a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer" data-testid="footer-feedback"
				>Send feedback</a
			>
		</nav>
		<p class="site-foot__cookie">
			This site only sets a sign-in cookie. Analytics are cookieless. <a
				href={resolve('/(site)/privacy')}>Details</a
			>
		</p>
	</div>
</footer>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
	.site-foot {
		border-top: 1px solid var(--ink);
		margin-top: 72px;
		background: var(--paper);
	}
	.site-foot__in {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--sp-10) var(--sp-8) 40px;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--sp-8);
	}
	.site-foot p {
		margin: 0;
	}
	.site-foot__mono {
		font: 400 var(--fs-md) / 1.5 var(--f-mono);
	}
	.site-foot__small,
	.site-foot__cookie {
		font-size: var(--fs-md);
		color: var(--muted);
		max-width: var(--measure);
	}
	.site-foot__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-4) var(--sp-10);
	}
	.site-foot__links a {
		color: var(--ink);
		min-height: 32px;
		display: inline-flex;
		align-items: center;
	}
	@media (min-width: 900px) {
		.site-foot__in {
			grid-template-columns: minmax(0, 5fr) minmax(0, 3fr) minmax(0, 4fr);
			align-items: start;
			gap: var(--sp-10);
		}
		.site-foot__cookie {
			justify-self: end;
		}
	}
</style>
