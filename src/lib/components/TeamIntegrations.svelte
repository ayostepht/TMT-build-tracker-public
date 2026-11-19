<script lang="ts">
	import { untrack } from 'svelte';
	import {
		getOrgSettings,
		getPrinterOptions,
		saveOrgSettings,
		type OrgSettingsDto
	} from '#lib/client/api.ts';
	import { PrinterStore } from '#lib/client/printer-store.svelte.ts';
	import type { ConnectionOptionView } from '#lib/printers/connection-options.ts';
	import { hasConnectedPrinter } from '#lib/printers/integrations-view.ts';
	import IntegrationPrinters from './IntegrationPrinters.svelte';

	/**
	 * Workspace Integrations: Printers (add, edit, remove) and automatic print logging. The printer
	 * options come from GET /api/printers/options.
	 */
	let { orgId }: { orgId: string } = $props();

	const store = new PrinterStore(untrack(() => orgId));
	$effect(() => store.acquire());

	let options = $state<ConnectionOptionView[]>([]);
	let optionsError = $state('');
	$effect(() => {
		void getPrinterOptions()
			.then((r) => (options = r.connectionOptions))
			.catch((e) => (optionsError = e instanceof Error ? e.message : 'Could not load the options'));
	});

	let s = $state<OrgSettingsDto | null>(null);
	let canEdit = $state(false);
	let msg = $state('');
	let err = $state('');
	let busy = $state(false);

	$effect(() => {
		void getOrgSettings(orgId)
			.then((r) => {
				s = r.settings;
				canEdit = r.canEdit;
			})
			.catch((e) => (err = e instanceof Error ? e.message : 'Could not load settings'));
	});

	async function save(patch: Partial<OrgSettingsDto>, note = 'Saved') {
		busy = true;
		err = '';
		msg = '';
		try {
			s = (await saveOrgSettings(orgId, patch)).settings;
			msg = note;
		} catch (e) {
			err = e instanceof Error ? e.message : 'Could not save';
		} finally {
			busy = false;
		}
	}
</script>

<!-- External guide links only (the repository on GitHub): nothing to resolve. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="ti-page" data-testid="team-integrations">
	{#if optionsError}<div class="error" role="alert">{optionsError}</div>{/if}
	<IntegrationPrinters {orgId} {store} {options} canEdit={store.canEdit || canEdit} />

	<section class="card ti-sec" data-testid="autolog-section" aria-labelledby="ti-autolog-h">
		<h2 id="ti-autolog-h">Automatic print logging</h2>
		{#if store.loaded && !hasConnectedPrinter(store.printers)}
			<p class="muted" data-testid="autolog-hint">
				This appears once a printer is connected: a printer that is not connected cannot tell the
				app when a print finishes.
			</p>
		{:else if s}
			<label class="ti-chk">
				<input
					type="checkbox"
					checked={s.autoLogPrints}
					disabled={!canEdit || busy}
					data-testid="autolog"
					onchange={(e) => save({ autoLogPrints: e.currentTarget.checked })}
				/>
				Log finished prints automatically
			</label>
			<p class="muted">
				When a connected printer finishes a print that is linked to a plate, log it with the plate's
				slicer grams and the printer's print time. Off: you get a "Confirm print log" prompt
				instead.
			</p>
			{#if !canEdit}<p class="muted">Only chapter owners and editors can change this.</p>{/if}
		{/if}
		<div role="status" class="ti-msg">{msg}</div>
		{#if err}<div class="error" role="alert">{err}</div>{/if}
	</section>
</div>

<style>
	.ti-page {
		display: grid;
		gap: var(--sp-8);
		align-content: start;
	}
	.ti-sec {
		display: grid;
		gap: var(--sp-4);
	}
	.ti-sec h2 {
		margin: 0;
	}
	.ti-sec p {
		margin: 0;
	}
	.ti-chk {
		display: flex;
		gap: var(--sp-4);
		align-items: center;
		font-size: var(--fs-md);
	}
	.ti-msg {
		font-size: var(--fs-sm);
		color: var(--ok);
		min-height: 1em;
	}
	.error {
		white-space: normal;
	}
</style>
