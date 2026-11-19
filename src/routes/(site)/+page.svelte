<script lang="ts">
	import { resolve } from '$app/paths';
	import ChairDrawing from '#lib/components/site/ChairDrawing.svelte';
	import PlateDiagram from '#lib/components/site/PlateDiagram.svelte';
	import { MAKEGOOD_GUIDE_URL, MAKEGOOD_MODEL_URL } from '#lib/makegood.ts';

	const REPO_URL = 'https://github.com/ayostepht/TMT-Build-Tracker';

	const parts = [
		{ no: '01', name: 'Headrest (soft)', status: 'Printed', tone: 'ok' },
		{ no: '02', name: 'Seat back top', status: 'Printed', tone: 'ok' },
		{ no: '03', name: 'Seat center', status: 'Printing', tone: 'run' },
		{ no: '04', name: 'Wing left', status: 'To print', tone: '' },
		{ no: '05', name: 'Footrest front', status: 'Reprint', tone: 'warn' }
	];
	const roles = [
		{ role: 'Primary', filament: 'PETG · Deep teal', color: '#2f5d62' },
		{ role: 'Accent', filament: 'PETG · Ochre', color: '#e0a458' },
		{ role: 'Soft', filament: 'PETG · Sand', color: '#efe6d2' },
		{ role: 'Tire', filament: 'TPU · Charcoal', color: '#3a3631' }
	];
</script>

<svelte:head>
	<title>TMT Build Tracker: plan, print and hand off MakeGood 3D TMT chairs</title>
	<meta
		name="description"
		content="A free, open source tracker for makers and teams 3D-printing the MakeGood 3D TMT toddler mobility trainer: colors, print plates, every part, and the hand-off."
	/>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="home">
	<section class="hero">
		<div class="hero__copy">
			<p class="mono-label">For people who print MakeGood 3D TMT chairs</p>
			<h1>One chair, dozens of printed parts, and a way to keep track of all of them.</h1>
			<p class="lede">
				The MakeGood 3D TMT is a toddler mobility trainer: a small chair on wheels that lets a child
				with limited mobility sit up, look around and start to move. MakeGood designed it and
				released the files as CC0, so anyone with a 3D printer can print one for a child who needs
				it. A chair is many parts over many plates, and it usually takes a few people. This tracker
				keeps the list.
			</p>
			<div class="cta">
				<a class="btn primary go" href="/demo">Try the demo, no account needed</a>
				<a class="btn" href={resolve('/login')}>Sign in with Google, GitHub or Discord</a>
			</div>
			<p class="fine">Free and open source. No ads, no email list, no password to forget.</p>
		</div>

		<aside class="sheet" aria-label="A sample build sheet">
			<div class="sheet__head">
				<span class="mono-label">Build sheet · Chair 7</span>
				<span class="mono-label">5 of 5 shown</span>
			</div>
			<div class="sheet__draw"><ChairDrawing callouts /></div>
			<ol class="sheet__list">
				{#each parts as p (p.no)}
					<li>
						<span class="pno">{p.no}</span>
						<span class="pname">{p.name}</span>
						<span class="ds-badge ds-badge--sm {p.tone ? `ds-badge--${p.tone}` : ''}"
							>{p.status}</span
						>
					</li>
				{/each}
			</ol>
		</aside>
	</section>

	<section class="band who">
		<h2 class="band__title">
			<span class="mono-label">Who it is for</span>Makers, and the teams they build with
		</h2>
		<div class="prose">
			<p>
				You have a printer, or a few, and you want to put a chair together for a kid. Maybe you work
				alone in the garage. Maybe your team is a dozen people with their own printers who each take
				a plate. Either way you need to know which parts are printed, which failed, which color goes
				where, and who has what.
			</p>
			<p>
				It is made by a maker, for makers. It does not tell you how to print. It keeps the record,
				so the build does not live in one person's head or in a spreadsheet nobody updates.
			</p>
		</div>
	</section>

	<section class="band">
		<h2 class="band__title"><span class="mono-label">What it does</span>From colors to hand-off</h2>

		<article class="step">
			<header class="step__head">
				<span class="step__no">01</span>
				<h3>Pick the colors</h3>
			</header>
			<div class="step__text">
				<p>
					Give each color role (primary, accent, soft, tire) a filament and see the chair in those
					colors before you print anything. The tracker adds up how much of each filament the build
					needs.
				</p>
				<p>
					Share a color design to the shared gallery and other signed-in makers can browse it and
					use it for their own builds.
				</p>
			</div>
			<div class="step__art colors">
				<div class="colors__chairs">
					<ChairDrawing />
					<ChairDrawing primary="#27426e" accent="#8ec1e8" soft="#f1ece0" tire="#2b2b2d" />
				</div>
				<ul class="swatches">
					{#each roles as r (r.role)}
						<li>
							<span class="swatch-chip" style="background:{r.color}" aria-hidden="true"></span>
							<span class="swatches__role">{r.role}</span>
							<span class="swatches__fil">{r.filament}</span>
						</li>
					{/each}
				</ul>
			</div>
		</article>

		<article class="step step--flip">
			<header class="step__head">
				<span class="step__no">02</span>
				<h3>Arrange parts onto plates</h3>
			</header>
			<div class="step__text">
				<p>
					The app lays the parts flat on plates sized for your printer's bed and shows how much of
					each plate is used. Parts keep the orientation the designer chose. If one does not fit
					flat, it says so rather than tipping it on its side.
				</p>
				<p>You can export a plate as a 3MF for your slicer.</p>
			</div>
			<div class="step__art"><PlateDiagram /></div>
		</article>

		<article class="step">
			<header class="step__head">
				<span class="step__no">03</span>
				<h3>Track every part, across the team</h3>
			</header>
			<div class="step__text">
				<p>
					Mark a plate printing from your phone at the printer, then printed when it comes off.
					Failed prints get logged and reprinted. Everyone on the team sees the same list, and the
					activity history says who did what.
				</p>
			</div>
			<div class="step__art ledger">
				<div class="ledger__top">
					<span class="mono-label">Seat · Frame · Wheels</span>
					<span class="num ledger__count">14 of 26 printed</span>
				</div>
				<div class="meter" role="img" aria-label="14 of 26 parts printed"><span></span></div>
				<ul>
					<li>
						<span class="pno">07</span> Wheel mount left
						<span class="ds-badge ds-badge--sm ds-badge--ok">Printed</span>
					</li>
					<li>
						<span class="pno">08</span> Wheel mount right
						<span class="ds-badge ds-badge--sm ds-badge--run">Printing</span>
					</li>
					<li>
						<span class="pno">09</span> Push handle top
						<span class="ds-badge ds-badge--sm">To print</span>
					</li>
				</ul>
				<p class="ledger__log">Plate 3 marked printed · 2 parts · 41 min ago</p>
			</div>
		</article>

		<article class="step step--flip">
			<header class="step__head">
				<span class="step__no">04</span>
				<h3>Assemble and hand it off</h3>
			</header>
			<div class="step__text">
				<p>
					When the last part is on, the build moves to assembly and then to a hand-off record: who
					received the chair, the date, and a few lines about the fitting. The record stays with the
					build.
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

	<section class="closer">
		<div>
			<h2>See it with a sample chair.</h2>
			<p>The demo gives you your own throwaway workspace. It is cleared after a day.</p>
		</div>
		<div class="cta cta--stack">
			<a class="btn primary go" href="/demo">Try the demo, no account needed</a>
			<a class="btn" href={resolve('/login')}>Sign in with Google, GitHub or Discord</a>
		</div>
	</section>
</div>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
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
		font-size: clamp(38px, 9vw, var(--fs-5xl));
		line-height: 0.98;
		letter-spacing: 0;
		font-weight: 600;
		max-width: 18ch;
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
	.sheet__draw {
		padding: var(--sp-6) var(--sp-4) var(--sp-2);
	}
	.sheet__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}
	.sheet__list li {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		gap: var(--sp-5);
		align-items: center;
		padding: var(--sp-4) 0;
		border-top: 1px solid var(--line);
		font-size: var(--fs-md);
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

	.colors {
		display: grid;
		gap: var(--sp-8);
	}
	.colors__chairs {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--sp-8);
	}
	.swatches {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: var(--sp-6) var(--sp-8);
	}
	.swatches li {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr);
		grid-template-rows: auto auto;
		column-gap: var(--sp-5);
		align-items: center;
	}
	.swatch-chip {
		grid-row: 1 / 3;
		width: 32px;
		height: 32px;
		border-radius: var(--r-sm);
		box-shadow: var(--ring-swatch);
	}
	.swatches__role {
		font-weight: 600;
		font-size: var(--fs-md);
	}
	.swatches__fil {
		font: 400 var(--fs-xs) var(--f-mono);
		color: var(--muted);
	}

	.ledger,
	.handoff {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: var(--sp-8);
		display: grid;
		gap: var(--sp-6);
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
	.meter {
		height: 8px;
		background: var(--accent-soft);
		border-radius: var(--r-sm);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		width: 54%;
		background: var(--accent);
	}
	.ledger ul {
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
	.ledger__log {
		font: 400 var(--fs-sm) var(--f-mono);
		color: var(--muted);
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
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
			gap: 64px;
			padding: 72px 0 80px;
			align-items: start;
		}
		.sheet {
			margin-top: 28px;
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
