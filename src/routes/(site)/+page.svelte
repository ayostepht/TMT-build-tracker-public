<script lang="ts">
	import { resolve } from '$app/paths';
	import HeroChair from '#lib/components/site/HeroChair.svelte';
	import StatusBadge from '#lib/components/StatusBadge.svelte';
	import KitCredit from '#lib/components/kit/KitCredit.svelte';
	import { MAKEGOOD_GUIDE_URL, MAKEGOOD_MODEL_URL } from '#lib/makegood.ts';
	import { REPO_URL } from '#lib/repo.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The two sample palettes the still images and the live hero were rendered with. */
	const teal = { primary: '#2f5d62', accent: '#e0a458', soft: '#efe6d2', tire: '#3a3631' };
	const blue = { primary: '#27426e', accent: '#8ec1e8', soft: '#f1ece0', tire: '#2b2b2d' };
	const swatches = [
		{ role: 'Primary', teal: 'Deep teal', blue: 'Navy' },
		{ role: 'Accent', teal: 'Ochre', blue: 'Sky' },
		{ role: 'Soft', teal: 'Sand', blue: 'Linen' },
		{ role: 'Tire', teal: 'Charcoal', blue: 'Graphite' }
	];
	const keys = ['primary', 'accent', 'soft', 'tire'] as const;

	const parts = [
		{ no: '04', name: 'Wheel Mount Right', status: 'Printing' },
		{ no: '05', name: 'Wing Right', status: 'Reprint' },
		{ no: '06', name: 'Wing Left', status: 'To print' },
		{ no: '10', name: 'Seat Back Top', status: 'Printed' },
		{ no: '11', name: 'Seat Center', status: 'Printed' }
	];
	const activity = [
		{ who: 'Dana', what: 'marked plate 4 printing', when: 'just now' },
		{ who: 'Marcus', what: 'logged plate 5 as failed, reprint queued', when: '2 h ago' },
		{ who: 'Dana', what: 'marked plate 11 printed, 180 g', when: 'yesterday' },
		{ who: 'Priya', what: 'added a photo to the headrest', when: 'yesterday' }
	];
</script>

<svelte:head>
	<title>TMT Build Tracker: plan, print and hand off MakeGood 3D TMT chairs</title>
	<meta
		name="description"
		content="A free, open source tracker for makers and teams 3D-printing the MakeGood 3D TMT toddler mobility trainer: every part and plate from printed to assembled, who did what, and the hand-off."
	/>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="home">
	{#if data.notice}<p class="home-notice" role="status" data-testid="home-notice">
			{data.notice}
		</p>{/if}
	<section class="hero">
		<div class="hero__copy">
			<p class="mono-label">For people who print MakeGood 3D TMT chairs</p>
			<h1>Keep a whole chair build organized, from the first plate to the hand-off.</h1>
			<p class="lede">
				A MakeGood 3D TMT chair is dozens of printed parts over many plates, and usually a few
				people printing them. This tracker keeps the list: what is printed, what failed and needs a
				reprint, who has what, and what is left before it can go to the child.
			</p>
			<div class="cta">
				{#if data.signedIn}
					<a
						class="btn primary go"
						href={resolve('/(app)/workspace')}
						data-testid="home-open-builds"
						>{data.isDemo ? 'Back to the demo' : 'Open your builds'}</a
					>
					{#if data.isDemo}<a class="btn" href={resolve('/login')}
							>Sign in to keep your own builds</a
						>{/if}
				{:else}
					<a class="btn primary go" href="/demo" data-sveltekit-reload
						>Try the demo, no account needed</a
					>
					<a class="btn" href={resolve('/login')}>Sign in</a>
				{/if}
			</div>
			<p class="fine">Free and open source. No ads, no email list, no password to forget.</p>
		</div>

		<figure class="sheet" aria-label="A sample build">
			<div class="sheet__head">
				<span class="mono-label">Build sheet · Sample chair</span>
				<span class="mono-label sheet__state">Plate 4 printing</span>
			</div>
			<div class="sheet__chair">
				<HeroChair
					model={data.hero?.model ?? null}
					partRoles={data.hero?.partRoles ?? {}}
					palette={teal}
					poster="/home/chair-teal.webp"
					alt="The MakeGood 3D TMT chair in deep teal and ochre, seen from the front and a little to the side."
				/>
			</div>
			<div class="sheet__foot">
				<div class="progress">
					<span class="mono-label">Parts printed</span>
					<span class="num progress__n">3 of 33</span>
				</div>
				<div class="meter" role="img" aria-label="3 of 33 parts printed"><span></span></div>
				<KitCredit />
			</div>
		</figure>
	</section>

	<section class="band">
		<h2 class="band__title">
			<span class="mono-label">How a build goes</span>Every part has a place
		</h2>

		<article class="step">
			<header class="step__head">
				<span class="step__no">01</span>
				<h3>One list for every part and plate</h3>
			</header>
			<div class="step__text">
				<p>
					Open the Print tab at the printer and mark a plate printing, then printed when it comes
					off. A failed print gets logged and goes back on the list as a reprint. Nobody has to
					remember which wing was the one that warped.
				</p>
			</div>
			<div class="step__art ledger">
				<div class="ledger__top">
					<span class="mono-label">Print · by plate</span>
					<span class="num ledger__count">3 of 33 printed</span>
				</div>
				<ul>
					{#each parts as p (p.no)}
						<li>
							<span class="pno">{p.no}</span>
							<span>{p.name}</span>
							<StatusBadge
								label={p.name}
								status={p.status}
								interactive={false}
								testid="home-status"
								small
							/>
						</li>
					{/each}
				</ul>
			</div>
		</article>

		<article class="step step--flip">
			<header class="step__head">
				<span class="step__no">02</span>
				<h3>Plates laid out for your printer</h3>
			</header>
			<div class="step__text">
				<p>
					Parts are arranged flat on plates sized for your bed, and each plate shows how full it is.
					Parts keep the orientation MakeGood designed. If one does not fit flat, the app says so
					instead of tipping it on its side. Export a plate as a 3MF for your slicer.
				</p>
				<p>
					Link a printer through an OctoEverywhere share and the plate follows the print by itself.
				</p>
			</div>
			<figure class="step__art plate">
				<picture>
					<source media="(prefers-color-scheme: dark)" srcset="/home/plate-dark.webp" />
					<img
						src="/home/plate-light.webp"
						alt="Top view of one print plate with the headrest parts laid flat and numbered, from the app's plate view."
						width="760"
						height="760"
						loading="lazy"
					/>
				</picture>
				<figcaption class="mono-label">The plate view, from a sample build</figcaption>
			</figure>
		</article>

		<article class="step">
			<header class="step__head">
				<span class="step__no">03</span>
				<h3>Everyone sees the same thing</h3>
			</header>
			<div class="step__text">
				<p>
					A team shares its builds, so the whole group works from one list. The activity history
					says who did what and when, and you can undo a mistake. Viewers can follow along without
					being able to change anything.
				</p>
			</div>
			<div class="step__art feed">
				<span class="mono-label">Activity</span>
				<ul>
					{#each activity as a (a.what)}
						<li>
							<span><b>{a.who}</b> {a.what}</span>
							<span class="feed__when">{a.when}</span>
						</li>
					{/each}
				</ul>
			</div>
		</article>

		<article class="step step--flip">
			<header class="step__head">
				<span class="step__no">04</span>
				<h3>Assemble, then hand it off</h3>
			</header>
			<div class="step__text">
				<p>
					When the last part is printed the build moves to assembly, with a checklist from the
					MakeGood guide. Then comes a hand-off record: who received the chair, the date, and a few
					lines about the fitting. It stays with the build.
				</p>
			</div>
			<div class="step__art handoff">
				<span class="mono-label">Hand-off record</span>
				<dl>
					<div>
						<dt>Received by</dt>
						<dd></dd>
					</div>
					<div>
						<dt>Date</dt>
						<dd></dd>
					</div>
					<div>
						<dt>Fitting notes</dt>
						<dd></dd>
					</div>
				</dl>
				<ul class="checks">
					<li><span class="box on"></span>Wheels spin freely</li>
					<li><span class="box on"></span>Straps checked</li>
					<li><span class="box"></span>Photo added</li>
				</ul>
			</div>
		</article>
	</section>

	<section class="band who">
		<h2 class="band__title">
			<span class="mono-label">Who it is for</span>Makers, and the teams they build with
		</h2>
		<div class="prose">
			<p>
				You have a printer, or a few, and you want to put a chair together for a child. Maybe you
				work alone in the garage. Maybe your team is a dozen people who each take a plate. Either
				way you need to know which parts are done and who has what.
			</p>
			<p>
				It does not tell you how to print. It keeps the record, so the build does not live in one
				person's head or in a spreadsheet nobody updates.
			</p>
		</div>
	</section>

	<section class="band colors-band">
		<h2 class="band__title">
			<span class="mono-label">And for choosing colors</span>The chair, in your filaments
		</h2>
		<div class="colors">
			<div class="prose">
				<p>
					When you are choosing colors, give each role (primary, accent, soft, tire) a filament and
					see the chair that way before you print. The tracker adds up how much of each filament the
					build needs. There is a design studio and a shared gallery for it, which is a bonus next
					to the tracking, not the point.
				</p>
			</div>
			<div class="colors__pair">
				{#each [{ img: 'chair-teal', alt: 'The chair in deep teal, ochre, sand and charcoal.', set: teal, name: 'teal' }, { img: 'chair-blue', alt: 'The same chair in navy, sky blue, linen and graphite.', set: blue, name: 'blue' }] as c (c.img)}
					<figure class="colors__one">
						<div class="colors__crop">
							<img src="/home/{c.img}.webp" alt={c.alt} width="1120" height="1240" loading="lazy" />
						</div>
						<ul class="swatches" aria-label="Colors in this design">
							{#each keys as k, i (k)}
								<li>
									<span class="swatch-chip" style="background:{c.set[k]}" aria-hidden="true"></span>
									<span>{swatches[i].role}</span>
									<span class="swatches__fil">{swatches[i][c.name as 'teal' | 'blue']}</span>
								</li>
							{/each}
						</ul>
					</figure>
				{/each}
			</div>
		</div>
	</section>

	<section class="band credit">
		<h2 class="band__title">
			<span class="mono-label">Where the chair comes from</span>The design is MakeGood's
		</h2>
		<div class="prose">
			<p>
				The 3D model and print files are by MakeGood, released under Creative Commons CC0 (public
				domain). This project did not design the chair and is not affiliated with MakeGood. Find the
				design on <a href={MAKEGOOD_MODEL_URL} target="_blank" rel="noopener noreferrer"
					>MakerWorld</a
				>
				and read their
				<a href={MAKEGOOD_GUIDE_URL} target="_blank" rel="noopener noreferrer">build guide</a> before
				you print.
			</p>
		</div>
	</section>

	<section class="band oss">
		<h2 class="band__title">
			<span class="mono-label">Free and open source</span>Free to use, open to read
		</h2>
		<div class="prose">
			<p>
				The tracker is free. The code is MIT-licensed and public on
				<a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>. Read it, report a
				bug, or send a fix.
			</p>
		</div>
	</section>

	{#if !data.signedIn}
		<section class="closer">
			<div>
				<h2>See it with a sample chair.</h2>
				<p>The demo gives you your own throwaway workspace. It is cleared after a day.</p>
			</div>
			<div class="cta cta--stack">
				<a class="btn primary go" href="/demo" data-sveltekit-reload
					>Try the demo, no account needed</a
				>
				<a class="btn" href={resolve('/login')}>Sign in</a>
			</div>
		</section>
	{/if}
</div>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
	.home-notice {
		margin: var(--sp-6) 0 0;
		padding: var(--sp-4) var(--sp-6);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--r-md, 6px);
		color: var(--ink);
		font-size: var(--fs-md);
	}
	.home {
		max-width: 1180px;
		margin: 0 auto;
		padding: 0 var(--sp-8);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}
	.mono-label {
		display: block;
		font: 500 var(--fs-xs) / 1.3 var(--f-mono);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.home p {
		margin: 0;
	}
	.home h1,
	.home h2,
	.home h3 {
		margin: 0;
	}

	/* hero */
	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 40px;
		padding: 40px 0 56px;
	}
	.hero__copy {
		display: grid;
		gap: var(--sp-8);
		align-content: start;
		min-width: 0;
	}
	.hero h1 {
		font-size: clamp(36px, 8.6vw, 58px);
		line-height: 1;
		letter-spacing: 0;
		font-weight: 600;
		max-width: 16ch;
	}
	.lede {
		font-size: var(--fs-lg);
		line-height: 1.55;
		max-width: var(--measure);
	}
	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-6);
	}
	.cta .btn {
		min-height: 48px;
		padding: var(--sp-5) var(--sp-9);
		font-size: var(--fs-base);
		font-weight: 600;
	}
	.fine {
		font: 400 var(--fs-sm) / 1.4 var(--f-mono);
		color: var(--muted);
	}
	.sheet {
		margin: 0;
		background: var(--card);
		border: 1px solid var(--ink);
		border-radius: var(--r-sm);
		padding: var(--sp-8);
		display: grid;
		gap: var(--sp-6);
		align-content: start;
		min-width: 0;
		/* a hard offset edge, like a stack of paper, instead of a soft drop shadow */
		box-shadow: 5px 5px 0 var(--line);
	}
	.sheet__head {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-5);
		padding-bottom: var(--sp-5);
		border-bottom: 1px solid var(--line);
	}
	.sheet__chair {
		width: min(100%, 400px);
		margin: 0 auto;
	}
	@media (max-width: 480px) {
		.sheet__state {
			display: none;
		}
	}
	.sheet__foot {
		display: grid;
		gap: var(--sp-4);
		padding-top: var(--sp-5);
		border-top: 1px solid var(--line);
	}
	.progress {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.progress__n {
		font: 600 var(--fs-lg) var(--f-display);
	}
	.meter {
		height: 8px;
		background: var(--accent-soft);
		border-radius: var(--r-sm);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		width: 9%;
		background: var(--accent);
	}
	.pno {
		font: 500 var(--fs-sm) var(--f-mono);
		color: var(--muted);
	}

	/* bands */
	.band {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--sp-9);
		padding: 40px 0;
		border-top: 1px solid var(--ink);
		align-items: start;
	}
	.band__title {
		display: grid;
		gap: var(--sp-4);
		font-size: var(--fs-2xl);
		line-height: 1.05;
		max-width: 16ch;
	}
	.prose {
		display: grid;
		gap: var(--sp-7);
		max-width: var(--measure);
		min-width: 0;
	}
	.prose p {
		line-height: 1.6;
	}

	/* steps */
	.step {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--sp-8);
		padding: var(--sp-10) 0;
		border-top: 1px solid var(--line);
		min-width: 0;
	}
	.step:first-of-type {
		border-top: 0;
		padding-top: 0;
	}
	.step__head {
		display: flex;
		align-items: baseline;
		gap: var(--sp-6);
	}
	.step__no {
		font: 500 var(--fs-md) var(--f-mono);
		color: var(--accent);
	}
	.step__head h3 {
		font-size: var(--fs-xl);
	}
	.step__text {
		display: grid;
		align-content: start;
		gap: var(--sp-6);
		max-width: var(--measure);
		line-height: 1.6;
	}
	.step__art {
		min-width: 0;
	}

	.ledger,
	.feed,
	.handoff {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: var(--sp-8);
		display: grid;
		gap: var(--sp-6);
		align-content: start;
		max-width: 520px;
	}
	.ledger__top {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-5);
		align-items: baseline;
	}
	.ledger__count {
		font: 600 var(--fs-lg) var(--f-display);
	}
	.ledger ul,
	.feed ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ledger li {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		gap: var(--sp-5);
		align-items: center;
		padding: var(--sp-4) 0;
		border-top: 1px solid var(--line);
		font-size: var(--fs-md);
	}
	.feed li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--sp-6);
		padding: var(--sp-4) 0;
		border-top: 1px solid var(--line);
		font-size: var(--fs-md);
		line-height: 1.4;
	}
	.feed__when {
		font: 400 var(--fs-xs) var(--f-mono);
		color: var(--muted);
		white-space: nowrap;
		padding-top: 2px;
	}

	.plate {
		margin: 0;
		display: grid;
		gap: var(--sp-5);
		max-width: 520px;
	}
	.plate img {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.handoff dl {
		margin: 0;
		display: grid;
		gap: var(--sp-5);
	}
	.handoff dl div {
		display: grid;
		grid-template-columns: 110px minmax(0, 1fr);
		gap: var(--sp-5);
		align-items: end;
	}
	.handoff dt {
		font-size: var(--fs-sm);
		color: var(--muted);
	}
	.handoff dd {
		margin: 0;
		height: 24px;
		border-bottom: 1px solid var(--ink);
	}
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--sp-4);
		font-size: var(--fs-md);
	}
	.checks li {
		display: flex;
		gap: var(--sp-5);
		align-items: center;
	}
	.box {
		width: 16px;
		height: 16px;
		border: 1.5px solid var(--ink);
		border-radius: var(--r-sm);
		flex: none;
	}
	.box.on {
		background: var(--ink);
		box-shadow: inset 0 0 0 2px var(--card);
	}

	/* the colors section is smaller and later than the tracking */
	.colors {
		display: grid;
		gap: var(--sp-8);
		min-width: 0;
	}
	.colors__pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--sp-8);
	}
	.colors__one {
		margin: 0;
		display: grid;
		gap: var(--sp-5);
		min-width: 0;
		align-content: start;
	}
	.colors__crop {
		position: relative;
		overflow: hidden;
		aspect-ratio: 1 / 1.08;
		width: 100%;
		max-width: 320px;
		margin: 0 auto;
	}
	.colors__crop img {
		position: absolute;
		left: -7.5%;
		top: 50%;
		width: 115%;
		height: auto;
		transform: translateY(-50%);
	}
	.swatches {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--sp-3);
	}
	.swatches li {
		display: grid;
		grid-template-columns: 20px auto minmax(0, 1fr);
		gap: var(--sp-4);
		align-items: center;
		font-size: var(--fs-sm);
	}
	.swatch-chip {
		width: 20px;
		height: 20px;
		border-radius: var(--r-sm);
		box-shadow: var(--ring-swatch);
	}
	.swatches__fil {
		font: 400 var(--fs-xs) var(--f-mono);
		color: var(--muted);
	}

	.closer {
		display: grid;
		gap: var(--sp-9);
		padding: 40px 0 0;
		border-top: 1px solid var(--ink);
		align-items: center;
	}
	.closer h2 {
		font-size: var(--fs-3xl);
		line-height: 1.05;
	}
	.closer p {
		margin-top: var(--sp-4);
		color: var(--muted);
	}

	@media (min-width: 900px) {
		.hero {
			grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
			gap: 64px;
			padding: 64px 0 80px;
			align-items: center;
		}
		.band {
			grid-template-columns: minmax(0, 4fr) minmax(0, 8fr);
			gap: 48px;
			padding: 56px 0;
		}
		.step {
			grid-template-columns: minmax(0, 4fr) minmax(0, 8fr);
			grid-template-areas:
				'head head'
				'text art';
			gap: var(--sp-9) 48px;
		}
		.step__head {
			grid-area: head;
		}
		.step__text {
			grid-area: text;
		}
		.step__art {
			grid-area: art;
		}
		.step--flip {
			grid-template-columns: minmax(0, 8fr) minmax(0, 4fr);
			grid-template-areas:
				'head head'
				'art text';
		}
		.band > .step {
			grid-column: 1 / -1;
		}
		.closer {
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
			gap: 48px;
			padding-top: 56px;
		}
		.cta--stack {
			justify-self: end;
		}
	}
	.cta--stack {
		flex-direction: column;
		align-items: stretch;
	}
	@media (max-width: 899px) {
		.cta .btn {
			flex: 1 1 100%;
		}
	}
</style>
