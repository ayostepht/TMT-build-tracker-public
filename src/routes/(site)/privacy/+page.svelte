<script lang="ts">
	import { resolve } from '$app/paths';
	import LegalPage from '#lib/components/LegalPage.svelte';
	import { ISSUES_URL } from '#lib/repo.ts';
	import { providerPhrase } from '#lib/sign-in-providers.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const providerText = $derived(providerPhrase(data.signInProviders));
</script>

<svelte:head><title>Privacy · TMT Build Tracker</title></svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<LegalPage title="Privacy" updated="2026-11-19" signedIn={data.signedIn} other="terms">
	<p>
		This page says what TMT Build Tracker stores about you and where it goes. It describes what the
		software does. You are using the public instance, which the TMT Build Tracker project runs (the
		"operator"). The operator can reach everything stored on the server and any backups of it.
	</p>
	<p>The app is for adult makers. It does not ask your age.</p>

	<h2>Your account</h2>
	<ul>
		<li>
			You sign in with {providerText || 'a supported provider'}. No password is stored, and no email
			is ever sent.
		</li>
		<li>
			Signing in creates your account. The app stores your <b>name</b>, your
			<b>email address</b> (only if the provider says it is verified), the address of your
			<b>profile picture</b> there (stored, not shown) and your <b>provider account id</b>. It keeps
			none of the provider's sign-in tokens.
		</li>
		<li>
			For each sign-in the server keeps a session record: when it started and expires and the
			browser identification (user agent) of the device. No IP address is stored. A session ends 7
			days after you last used the app. Signing out or deleting your account removes it.
		</li>
	</ul>

	<h2>Cookies and analytics</h2>
	<ul>
		<li>
			The only cookie is the sign-in session cookie, which keeps you signed in. In the demo it is a
			demo session cookie that works the same way and ends within 24 hours. There are no advertising
			or tracking cookies.
		</li>
		<li>
			Visits may be counted with a cookieless analytics service chosen by the operator. It sets no
			cookie and does not follow you across sites. If the operator has not set one up, there are no
			analytics at all.
		</li>
	</ul>

	<h2>The demo</h2>
	<p>
		The demo needs no account. It makes a private, throwaway workspace with a sample build under a
		made-up name and address, and a session cookie. It is <b>deleted after 24 hours</b>, or when you
		sign out of it, with everything in it. Nothing is carried over to an account.
	</p>

	<h2>What you put in builds</h2>
	<ul>
		<li>
			Builds hold names, notes, status, print logs and settings. Who the chair is for and which
			hospital or clinic are optional free-text fields, and the handoff record has a recipient name,
			an organization and a contact field. <b>Please don't enter a child's personal details</b>:
			leave them blank or use a label such as "Chair 7".
		</li>
		<li>
			Photos are stored on the server. Location and camera details (EXIF, XMP, IPTC and comments)
			are removed from them when they are stored. Please don't photograph a child's face unless
			their guardian agrees.
		</li>
		<li>
			A slicer file (3MF) you upload is read and then deleted. What stays is a summary (including
			the file name) and the plate preview images.
		</li>
		<li>
			The activity history records what was done, when, and by whom. Each build keeps its newest
			5000 entries; older ones are removed as new ones arrive.
		</li>
	</ul>

	<h2>Who can see what</h2>
	<ul>
		<li>"My builds" is yours alone. It cannot be shared or take invitations.</li>
		<li>
			People in a team can see each other's name and email address, and the team's builds, photos
			and activity. Their role (owner, editor or viewer) decides who can change things.
		</li>
		<li>
			Invitations are links you copy and send yourself. The invited person's email address is stored
			with the invitation. Cancelled, declined and expired invitations beyond the newest 50 in a
			team are deleted when a new one is created; accepted ones are kept, and deleting an account
			removes invitations sent by or addressed to it.
		</li>
		<li>
			A color design you share to the gallery is visible to every signed-in user with its name and
			colors.
		</li>
	</ul>

	<h2>Printers</h2>
	<p>
		The only way to connect a printer is an OctoEverywhere shared link that you paste in. It is
		stored encrypted and never sent back to your browser. The server reads the printer's status (and
		camera picture) through OctoEverywhere. It makes no connection to anything on your own network
		and does not use Spoolman. You can also add printers that are not connected, which only store a
		name.
	</p>

	<h2>What leaves the server</h2>
	<ul>
		<li>
			Nothing goes to advertising services. The cookieless analytics above is the only third-party
			count, and only if the operator turned it on. Pages load their code, fonts and images from the
			app's own address.
		</li>
		<li>No email is sent.</li>
		<li>
			The provider you sign in with{providerText ? ` (currently ${providerText})` : ''} learns that you
			signed in, because you use it to do so. For a linked printer, OctoEverywhere answers the status
			requests.
		</li>
		<li>
			The links to MakeGood, GitHub and the build guide are plain links; nothing is sent until you
			click one.
		</li>
	</ul>

	<h2>On your device</h2>
	<ul>
		<li>
			Local storage keeps small display choices on this device, such as collapsed panels, recently
			used colors, preferred filament brands and the export format.
		</li>
		<li>
			A service worker caches the app's own code, fonts, icons and 3D model files so the app opens
			quickly and shows an offline page. It does not cache your data. Signing out deletes the 3D
			model files it cached on this device. Your browser may also keep photos you opened in its
			normal cache.
		</li>
	</ul>

	<h2>Export and delete</h2>
	<p>
		{#if data.signedIn}
			On <a href={resolve('/(app)/account')}>your account page</a>
		{:else}
			On the account page, once you are signed in,
		{/if}
		you can download your data as one JSON file (your profile, teams, saved designs and the builds in
		My builds; photos by file name only; team builds are not included) and delete your account. You confirm
		by typing your email address. Deleting removes your sign-in and everything in My builds, including
		photos, drafts, saved designs and custom filaments, and your drafts in teams. Builds you made in a
		team stay with the team, and their activity shows "Someone" instead of your name. A team where you
		are the only member is deleted with you. You cannot delete your account while you are the only owner
		of a team that has other members, or if you are the last site admin.
	</p>
	<p>
		Backups are made and kept by the operator, not by the app, so a deleted account can still be in
		an older backup.
	</p>

	<h2>Questions</h2>
	<p>
		Open an issue on <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub</a>.
		Please leave out personal details.
	</p>
</LegalPage>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
