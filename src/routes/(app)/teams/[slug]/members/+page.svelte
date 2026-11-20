<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Dialog from '#lib/components/design/share/Dialog.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const isOwner = $derived(data.role === 'owner');
	const inviteUrl = (id: string) => `${page.url.origin}/invite/${id}`;
	/** The system share sheet exists on most phones; elsewhere only "Copy link" is shown. */
	const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
	async function shareLink(id: string) {
		try {
			await navigator.share({
				title: `Join ${data.team.name} on TMT Build Tracker`,
				text: `Join ${data.team.name} on TMT Build Tracker`,
				url: inviteUrl(id)
			});
		} catch {
			// Dismissed the share sheet, or sharing failed: nothing to do, the link is still on screen.
		}
	}

	/** Member being removed: asked about in a dialog, not a browser confirm(). */
	let removing = $state<{ id: string; name: string } | null>(null);

	/** Leaving and deleting the team: confirmed in dialogs; the sole owner picks who takes over. */
	let leaving = $state(false);
	let heir = $state('');
	const heirName = $derived(data.leave.heirs.find((h) => h.userId === heir)?.name ?? '');
	let deleting = $state(false);
	let typedName = $state('');
	let busy = $state(false);
	const nameMatches = $derived(typedName.trim() === data.team.name.trim());
	const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

	/** Which invite link was just copied ("Copied" confirmation); a failed copy leaves the field selected. */
	let copied = $state<string | null>(null);
	let pendingLinks = $state<Record<string, HTMLInputElement | null>>({});
	let newLink = $state<HTMLInputElement | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyLink(id: string, input: HTMLInputElement | null) {
		try {
			await navigator.clipboard.writeText(inviteUrl(id));
			copied = id;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = null), 2500);
		} catch {
			// No clipboard access (plain http, permissions): select the link so it can be copied by hand.
			input?.focus();
			input?.select();
		}
	}
</script>

<svelte:head><title>Members · {data.team.name}</title></svelte:head>

{#if form?.error}<div class="error" role="alert">{form.error}</div>{/if}

<h2>Members</h2>
<ul class="tpl-list">
	{#each data.members as m (m.id)}
		<li class="ds-card ds-card--compact" data-testid="member-row">
			<b>{m.name}</b> <span class="muted">{m.email}</span>
			{#if isOwner}
				<form
					method="post"
					action="?/setRole"
					use:enhance={({ formElement }) =>
						async ({ result, update }) => {
							await update();
							// A refused change leaves the menu showing the role it still has.
							if (result.type !== 'success') {
								const sel = formElement.elements.namedItem('role') as HTMLSelectElement | null;
								if (sel) sel.value = m.role;
							}
						}}
				>
					<input type="hidden" name="memberId" value={m.id} />
					<select
						class="mem-role"
						name="role"
						value={m.role}
						aria-label="Role of {m.name}"
						onchange={(e) => e.currentTarget.form?.requestSubmit()}
					>
						<option value="owner">owner</option>
						<option value="editor">editor</option>
						<option value="viewer">viewer</option>
					</select>
				</form>
				{#if m.userId === data.me.userId}
					<span class="ds-badge ds-badge--sm mem-you" data-testid="member-you">you</span>
				{:else}
					<button
						class="btn"
						type="button"
						data-testid="remove-member"
						onclick={() => (removing = { id: m.id, name: m.name })}>Remove</button
					>
				{/if}
			{:else}
				<span class="ds-badge ds-badge--sm">{m.role}</span>
			{/if}
		</li>
	{/each}
</ul>

{#if isOwner}
	<h2>Invite</h2>
	{#if form?.invited}
		<div class="card stack" data-testid="invite-created">
			<span>Invitation for {form.invited.email}. Share this link:</span>
			<div class="mem-link">
				<input
					bind:this={newLink}
					readonly
					aria-label="Invite link"
					value={inviteUrl(form.invited.id)}
					onfocus={(e) => e.currentTarget.select()}
				/>
				<button
					class="btn"
					type="button"
					data-testid="copy-invite"
					onclick={() => copyLink(form.invited!.id, newLink)}
					>{copied === form.invited.id ? 'Copied' : 'Copy link'}</button
				>
				{#if canShare}
					<button
						class="btn"
						type="button"
						data-testid="share-invite"
						onclick={() => shareLink(form.invited!.id)}>Share</button
					>
				{/if}
			</div>
		</div>
	{/if}
	<form class="card stack" method="post" action="?/invite" use:enhance>
		<label class="field"
			>Email<input type="email" name="email" required aria-describedby="invite-why" /></label
		>
		<p class="muted mem-why" id="invite-why">
			The link only works for the account with this email. Nothing is emailed; you send the link
			yourself.
		</p>
		<label class="field"
			>Role
			<select name="role">
				<option value="editor" selected>editor</option>
				<option value="viewer">viewer</option>
			</select>
		</label>
		<button class="btn primary">Create invite link</button>
	</form>
	{#if data.invites.length}
		<h3>Pending invitations</h3>
		<ul class="tpl-list">
			{#each data.invites as i (i.id)}
				<li class="ds-card ds-card--compact">
					{i.email} ({i.role})
					<div class="mem-link">
						<input
							bind:this={pendingLinks[i.id]}
							readonly
							aria-label="Invite link for {i.email}"
							value={inviteUrl(i.id)}
							onfocus={(e) => e.currentTarget.select()}
						/>
						<button
							class="btn"
							type="button"
							data-testid="copy-pending-invite"
							onclick={() => copyLink(i.id, pendingLinks[i.id] ?? null)}
							>{copied === i.id ? 'Copied' : 'Copy link'}</button
						>
						{#if canShare}
							<button
								class="btn"
								type="button"
								data-testid="share-pending-invite"
								onclick={() => shareLink(i.id)}>Share</button
							>
						{/if}
					</div>
					<form method="post" action="?/revoke" use:enhance>
						<input type="hidden" name="id" value={i.id} />
						<button class="btn">Revoke</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<section class="card stack" data-testid="leave-section">
	<h2>Leave this team</h2>
	{#if data.leave.onlyMember}
		<p class="muted" data-testid="leave-only-member">
			You're the only one here. Delete the team instead.
		</p>
	{:else}
		<p class="muted">
			You lose access to this team's builds and printers. Builds you created stay with the team.
		</p>
		{#if data.leave.needsHeir}
			<label class="field mem-heir"
				>Choose who takes over as owner
				<select bind:value={heir} data-testid="leave-heir">
					<option value="">Choose a member…</option>
					{#each data.leave.heirs as h (h.userId)}
						<option value={h.userId}>{h.name} ({h.role})</option>
					{/each}
				</select>
			</label>
			<p class="muted mem-why">
				You are the only owner. They become an owner, then you leave, in one step.
			</p>
		{/if}
		{#if form?.exitError && form.what === 'leave' && !leaving}
			<div class="error" role="alert" data-testid="leave-error">{form.exitError}</div>
		{/if}
		<div>
			<button
				class="btn danger"
				type="button"
				data-testid="leave-open"
				disabled={data.leave.needsHeir && !heir}
				onclick={() => (leaving = true)}>Leave team…</button
			>
		</div>
	{/if}
</section>

{#if isOwner && data.deletion}
	<section class="card danger-zone stack" data-testid="delete-team-section">
		<h2>Delete this team</h2>
		<p class="muted">
			Deletes the team and everything in it for good. It cannot be undone. Your own builds in My
			builds are not touched.
		</p>
		{#if form?.exitError && form.what === 'delete' && !deleting}
			<div class="error" role="alert">{form.exitError}</div>
		{/if}
		<div>
			<button
				class="btn danger"
				type="button"
				data-testid="delete-team-open"
				onclick={() => (deleting = true)}>Delete this team…</button
			>
		</div>
	</section>
{/if}

{#if leaving}
	<Dialog
		title="Leave {data.team.name}?"
		onclose={() => (leaving = false)}
		testid="leave-dialog"
		danger
	>
		<p>
			You lose access to this team's builds and printers. Builds you created stay with the team.
			{#if data.leave.needsHeir && heirName}{heirName} becomes an owner.{/if}
		</p>
		{#if form?.exitError && form.what === 'leave'}
			<div class="error" role="alert" data-testid="leave-dialog-error">{form.exitError}</div>
		{/if}
		<form
			class="mem-actions"
			method="post"
			action="?/leave"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<input type="hidden" name="heir" value={heir} />
			<button class="btn" type="button" data-cancel onclick={() => (leaving = false)}>Cancel</button
			>
			<button class="btn danger solid" disabled={busy} data-testid="leave-confirm"
				>Leave team</button
			>
		</form>
	</Dialog>
{/if}

{#if deleting && data.deletion}
	{@const d = data.deletion}
	<Dialog
		title="Delete {data.team.name}?"
		onclose={() => (deleting = false)}
		testid="delete-team-dialog"
		danger
	>
		<form
			class="stack"
			method="post"
			action="?/deleteTeam"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<p>This permanently deletes:</p>
			<ul class="mem-list" data-testid="delete-team-summary">
				<li>{plural(d.builds, 'build')}, with their plates, runs, activity and photos</li>
				<li>
					{#if d.otherMembers}{plural(d.otherMembers, 'other person', 'other people')}
						{d.otherMembers === 1 ? 'loses' : 'lose'} access{:else}No other members{/if}
				</li>
				<li>{plural(d.printers, 'printer')}, with their saved connection details</li>
				{#if d.pendingInvitations}<li>{plural(d.pendingInvitations, 'open invitation')}</li>{/if}
				<li>The team's custom kits, filaments and uploaded files</li>
			</ul>
			{#if form?.exitError && form.what === 'delete'}
				<div class="error" role="alert" data-testid="delete-team-error">{form.exitError}</div>
			{/if}
			<label class="field"
				>Type the team name ({data.team.name}) to confirm
				<input
					name="name"
					bind:value={typedName}
					autocomplete="off"
					required
					data-testid="delete-team-name"
				/></label
			>
			<div class="mem-actions">
				<button class="btn" type="button" data-cancel onclick={() => (deleting = false)}
					>Cancel</button
				>
				<button
					class="btn danger solid"
					disabled={!nameMatches || busy}
					data-testid="delete-team-confirm">Delete team forever</button
				>
			</div>
		</form>
	</Dialog>
{/if}

{#if removing}
	{@const who = removing}
	<Dialog
		title="Remove {who.name}?"
		onclose={() => (removing = null)}
		testid="remove-member-dialog"
		danger
	>
		<p>
			{who.name} will lose access to this team's builds and printers. Their print history stays.
		</p>
		<form
			class="mem-actions"
			method="post"
			action="?/remove"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					removing = null;
				};
			}}
		>
			<input type="hidden" name="memberId" value={who.id} />
			<button class="btn" type="button" data-cancel onclick={() => (removing = null)}>Cancel</button
			>
			<button class="btn primary" data-testid="confirm-remove-member">Remove member</button>
		</form>
	</Dialog>
{/if}

<style>
	.mem-why {
		margin: 0;
		font-size: var(--fs-sm);
	}
	.mem-role {
		padding: var(--sp-3) var(--sp-5);
		border: 1px solid var(--field-line);
		border-radius: var(--r-md);
		background: var(--paper);
		min-height: 40px;
	}
	@media (pointer: coarse) {
		.mem-role {
			min-height: 44px;
		}
	}
	.mem-link {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.mem-link input {
		flex: 1 1 220px;
		min-width: 0;
	}
	.mem-you {
		justify-self: start;
		align-self: start;
		width: fit-content;
	}
	.mem-heir select {
		max-width: 100%;
		min-width: 0;
	}
	.mem-list {
		margin: 0;
		padding-left: 18px;
		display: grid;
		gap: 6px;
	}
	.mem-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
</style>
