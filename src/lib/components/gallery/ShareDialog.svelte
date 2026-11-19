<script lang="ts">
	import Dialog from '#lib/components/design/share/Dialog.svelte';
	import Swatch from '#lib/components/Swatch.svelte';
	import { filamentLabel, roleLabel, sortRoles } from '#lib/domain/labels.ts';

	/** Confirmation before a design goes to the gallery: says exactly what other people will see. */
	let {
		name,
		roles,
		sharerName,
		hasSnapshot,
		busy = false,
		onconfirm,
		oncancel
	}: {
		name: string;
		roles: { key: string; name: string; material: string; hex: string }[];
		sharerName: string;
		hasSnapshot: boolean;
		busy?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();
</script>

<Dialog title="Share to the gallery?" onclose={oncancel} testid="share-gallery-dialog">
	<div class="gal-confirm">
		<p>
			Every signed-in user will be able to see "{name}" in the gallery and save a copy. This is what
			becomes visible:
		</p>
		<ul class="gal-shows">
			<li><b>Name:</b> {name}</li>
			<li>
				<b>Colors:</b>
				<span class="gal-sw">
					{#each sortRoles(roles, (r) => r.key) as r (r.key)}
						<span class="gal-sw-row">
							<Swatch hex={r.hex} size="mini" />
							<span
								>{roleLabel(r.key, r)}: {filamentLabel(r, r.key)}
								<span class="muted">{r.hex}</span></span
							>
						</span>
					{/each}
				</span>
			</li>
			<li>
				<b>Preview:</b>
				{hasSnapshot ? 'the saved chair preview' : 'a strip of the colors (no preview saved)'}
			</li>
			<li><b>Shared by:</b> {sharerName}</li>
		</ul>
		<p class="muted gal-note">
			Your team's name and your email are never shown. If you stop sharing later, copies other
			people already saved stay with them.
		</p>
		<div class="gal-acts">
			<button class="btn" type="button" onclick={oncancel}>Cancel</button>
			<button class="btn primary" type="button" disabled={busy} onclick={onconfirm}
				>Share to the gallery</button
			>
		</div>
	</div>
</Dialog>

<style>
	.gal-confirm {
		display: grid;
		gap: var(--sp-6);
		min-width: 0;
	}
	.gal-confirm p {
		margin: 0;
	}
	.gal-shows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--sp-4);
	}
	.gal-sw {
		display: grid;
		gap: var(--sp-2);
		margin-top: var(--sp-2);
	}
	.gal-sw-row {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
		min-width: 0;
	}
	.gal-note {
		font-size: var(--fs-sm);
	}
	.gal-acts {
		display: flex;
		gap: var(--sp-4);
		flex-wrap: wrap;
		justify-content: flex-end;
	}
</style>
