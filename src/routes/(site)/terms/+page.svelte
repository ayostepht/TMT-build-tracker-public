<script lang="ts">
	import { resolve } from '$app/paths';
	import LegalPage from '#lib/components/LegalPage.svelte';
	import { MAKEGOOD_GUIDE_URL } from '#lib/makegood.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ISSUES_URL = 'https://github.com/ayostepht/TMT-Build-Tracker/issues';
</script>

<svelte:head><title>Terms · TMT Build Tracker</title></svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<LegalPage title="Terms" updated="2026-11-19" signedIn={data.signedIn} other="privacy">
	<p>
		These are the ground rules for using TMT Build Tracker, in plain words. By signing in, which
		creates your account, or by starting the demo, you agree to them.
	</p>

	<h2>Who it is for</h2>
	<p>
		Adult makers who 3D-print the MakeGood 3D TMT (toddler mobility trainer) chair, alone or with a
		team, and want to plan, print, assemble and hand off builds.
	</p>

	<h2>The software</h2>
	<p>
		TMT Build Tracker is open source under the MIT license and is provided "as is", without warranty
		of any kind. You are using the public instance, which the TMT Build Tracker project runs.
	</p>

	<h2>Not medical or safety guidance</h2>
	<p>
		The app is a build organizer. It tracks parts, plates, filament and steps. It does not check
		that a chair is safe and it is not medical advice.
		<a href={MAKEGOOD_GUIDE_URL} target="_blank" rel="noopener noreferrer">MakeGood's build guide</a
		>
		and your own checks decide whether a chair is safe to hand over.
	</p>

	<h2>MakeGood</h2>
	<p>
		The chair design and its print files are by MakeGood, released under CC0, and credited in the
		app, except the optional one-piece push handle, which is by jeepxj under CC BY-NC. This is an
		independent project. It is not made, endorsed or run by MakeGood, and it is not affiliated with
		them. The build guide is not part of the app; it is only linked.
	</p>

	<h2>What you upload and enter</h2>
	<p>
		You are responsible for what you upload and enter. Use only content you have the right to use.
		Don't put other people's personal data into the app without their permission, and keep a child's
		personal details out of it (see Privacy).
	</p>

	<h2>Printers</h2>
	<p>
		You can link a printer through an OctoEverywhere shared link. The app only reads its status. It
		never starts, stops, moves, heats or otherwise controls a printer, and it makes no connection to
		anything on your own network. You stay responsible for your printer and for watching it.
	</p>

	<h2>The demo</h2>
	<p>
		The demo is a private, throwaway workspace with a sample build, for trying the app without an
		account. Uploads, printers and teams are switched off in it. It is deleted 24 hours after you
		start it, or when you sign out of it, and nothing in it can be moved to an account.
	</p>

	<h2>Your account</h2>
	<ul>
		<li>
			You sign in with Google, GitHub or Discord. Keep that account secure; what happens in your
			account is your responsibility.
		</li>
		<li>
			You can delete your account yourself on <a href={resolve('/(app)/account')}
				>the account page</a
			>.
		</li>
		<li>
			Fair-use limits apply (for example on how many builds, uploads and requests an account can
			make).
		</li>
		<li>Accounts or content may be removed for abuse.</li>
		<li>
			The service may change or stop. If you depend on your data, download it from your account page
			now and then.
		</li>
	</ul>

	<h2>Reporting a problem</h2>
	<p>
		Open an issue on <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub</a>.
		Please leave out personal details.
	</p>
</LegalPage>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
