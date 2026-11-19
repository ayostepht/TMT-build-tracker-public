<script lang="ts">
	import { addPrinter, testPrinter, testPrinterCamera, updatePrinter } from '#lib/client/api.ts';
	import { printerBrands } from '#lib/printers/catalog.ts';
	import { cameraSupported } from '#lib/printers/camera-url.ts';
	import type { ConnectionOptionView } from '#lib/printers/connection-options.ts';
	import { EXPERIMENTAL_TAG, isExperimental } from '#lib/printers/integrations-view.ts';
	import { ISSUES_URL, SETUP_TEXT, guideUrl } from '#lib/printers/setup-steps.ts';
	import {
		PRINTER_KIND_INFO,
		PRINTER_KINDS,
		type PrinterKind,
		type PrinterPublic,
		type PrinterStatus
	} from '#lib/printers/status.ts';
	import PrinterCard from './PrinterCard.svelte';

	/**
	 * Add or edit a printer. Secret fields are write-only: blank keeps the stored value.
	 * With `option` (the Integrations page) the form is that one connection option: only its fields,
	 * its setup steps above them, no printer-type select. Without it (the plate picker's inline
	 * "New printer") it is the general form with a type select. `typeChoices` (OctoEverywhere only)
	 * adds a "Printer type" select that calls `ontype` with the chosen option's key.
	 */
	let {
		org,
		printer = null,
		option = null,
		typeChoices = [],
		ontype,
		ondone,
		oncancel
	}: {
		org: string;
		printer?: PrinterPublic | null;
		option?: ConnectionOptionView | null;
		typeChoices?: { key: string; label: string }[];
		ontype?: (key: string) => void;
		ondone: () => void;
		oncancel: () => void;
	} = $props();

	const brands = printerBrands();
	const init = () => ({
		name: printer?.name ?? '',
		kind: (printer?.kind ?? option?.kind ?? 'elegoo-sdcp') as PrinterKind,
		catalogId: printer?.catalogId ?? '',
		enabled: printer?.enabled ?? true,
		cameraEnabled: printer?.cameraEnabled ?? true
	});
	let f = $state(init());
	let secrets = $state<Record<string, string>>({});
	$effect(() => {
		// reset typed secrets when switching kind
		void f.kind;
		secrets = {};
	});
	const info = $derived(PRINTER_KIND_INFO[f.kind]);
	const hasSavedLink = $derived(!!printer?.secretsSet.includes('shareLink'));
	/** A printer that is never contacted: a name (and model) is all there is. */
	const isManual = $derived(f.kind === 'manual');
	const optField = (key: string) => option?.fields.find((x) => x.key === key);
	const fieldList = $derived(
		info.secrets.filter((x) => (option ? !!optField(x.key) : x.key !== 'mainboardId'))
	);
	const setup = $derived(option ? SETUP_TEXT[option.key] : null);
	const canTest = $derived(isManual ? false : !!secrets.shareLink?.trim() || hasSavedLink);

	let busy = $state(false);
	let error = $state('');
	let testing = $state(false);
	let test = $state<{ connected: boolean; status: PrinterStatus | null; message?: string } | null>(
		null
	);
	let camTesting = $state(false);
	let cam = $state<{ works: boolean; message?: string; image?: string } | null>(null);
	const camSupported = $derived(cameraSupported(f.kind));

	function payload() {
		const s: Record<string, string> = {};
		for (const fld of info.secrets) {
			const typed = secrets[fld.key];
			if (typed !== undefined && (typed !== '' || !fld.secret)) s[fld.key] = typed;
		}
		if (isManual)
			return { name: f.name, kind: f.kind, catalogId: f.catalogId || null, enabled: true };
		return {
			name: f.name,
			kind: f.kind,
			catalogId: f.catalogId || null,
			enabled: f.enabled,
			cameraEnabled: f.cameraEnabled,
			secrets: s
		};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			if (printer) await updatePrinter(printer.id, payload());
			else await addPrinter(org, payload());
			ondone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save';
		} finally {
			busy = false;
		}
	}

	async function runTest() {
		testing = true;
		test = null;
		error = '';
		try {
			test = await testPrinter(org, { ...payload(), id: printer?.id });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Test failed';
		} finally {
			testing = false;
		}
	}

	async function runCameraTest() {
		camTesting = true;
		cam = null;
		error = '';
		try {
			cam = await testPrinterCamera(org, { ...payload(), id: printer?.id });
		} catch (err) {
			cam = { works: false, message: err instanceof Error ? err.message : 'Camera test failed' };
		} finally {
			camTesting = false;
		}
	}
</script>

<!-- External guide links only (the repository on GitHub): nothing to resolve. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<form class="card pf" onsubmit={save} data-testid="printer-form">
	<h3>{printer ? `Edit ${printer.name}` : 'Add a printer'}</h3>
	{#if setup && option}
		{#if printer}
			<details class="pf-steps" data-testid="pf-steps">
				<summary>How this is set up</summary>
				<ol>
					{#each setup.steps as st (st)}<li>{st}</li>{/each}
				</ol>
				<a href={guideUrl(setup.anchor)} target="_blank" rel="noreferrer noopener">Full guide</a>
			</details>
		{:else}
			<div class="pf-steps" data-testid="pf-steps">
				<h4>How to set it up</h4>
				<ol>
					{#each setup.steps as st (st)}<li>{st}</li>{/each}
				</ol>
				<a
					class="pf-guide"
					href={guideUrl(setup.anchor)}
					target="_blank"
					rel="noreferrer noopener"
					data-testid="pf-guide">Full guide</a
				>
			</div>
		{/if}
	{/if}
	<div class="form-grid">
		<label class="field"
			>Name <input bind:value={f.name} required maxlength="80" placeholder="Shop Centauri" /></label
		>
		{#if typeChoices.length}
			<label class="field"
				>Printer type
				<select
					value={option?.key}
					disabled={!!printer}
					data-testid="pf-link-type"
					onchange={(e) => ontype?.(e.currentTarget.value)}
				>
					{#each typeChoices as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
				</select>
				{#if option && isExperimental(option)}
					<small class="pf-exp" data-testid="pf-experimental"
						><span class="pf-tag">{EXPERIMENTAL_TAG}</span>
						<a href={ISSUES_URL} target="_blank" rel="noreferrer noopener">Tell us how it went</a
						></small
					>
				{/if}
			</label>
		{:else if !option}
			<label class="field"
				>Type
				<select bind:value={f.kind} disabled={!!printer} data-testid="pf-kind">
					{#each PRINTER_KINDS as k (k)}<option value={k}>{PRINTER_KIND_INFO[k].label}</option
						>{/each}
				</select>
			</label>
		{/if}
		{#each fieldList as fld (fld.key)}
			<label class="field"
				>{optField(fld.key)?.label ?? fld.label}
				<input
					type={fld.secret ? 'password' : 'text'}
					autocomplete="off"
					autocapitalize="none"
					required={!!optField(fld.key)?.required && !printer?.secretsSet.includes(fld.key)}
					value={secrets[fld.key] ?? (fld.secret ? '' : (printer?.identifiers[fld.key] ?? ''))}
					placeholder={fld.secret && printer?.secretsSet.includes(fld.key)
						? 'Saved (leave blank to keep)'
						: ''}
					data-testid="pf-{fld.key}"
					oninput={(e) => (secrets[fld.key] = e.currentTarget.value)}
				/>
				{#if optField(fld.key)?.hint ?? fld.hint}<small>{optField(fld.key)?.hint ?? fld.hint}</small
					>{/if}
			</label>
		{/each}
		{#if !option || optField('catalogId')}
			<label class="field"
				>Model (optional)
				<select bind:value={f.catalogId}>
					<option value="">Not set</option>
					{#each brands as b (b.brand)}
						<optgroup label={b.brand}>
							{#each b.printers as p (p.id)}<option value={p.id}>{p.model}</option>{/each}
						</optgroup>
					{/each}
				</select>
			</label>
		{/if}
	</div>
	{#if !option}<p class="muted hint">{info.hint}</p>{/if}

	{#if !isManual}
		<fieldset class="cam" data-testid="pf-camera">
			<legend>Camera</legend>
			{#if camSupported}
				<label class="chk"
					><input type="checkbox" bind:checked={f.cameraEnabled} data-testid="pf-camera-on" /> Show the
					camera while this printer is printing</label
				>
				<p class="muted hint" data-testid="pf-camera-via-link">
					The camera comes through the OctoEverywhere link too.
				</p>
				<div class="actions">
					<button
						class="btn sm"
						type="button"
						onclick={runCameraTest}
						disabled={camTesting || !canTest}
						data-testid="pf-camera-test">{camTesting ? 'Testing…' : 'Test camera'}</button
					>
				</div>
				{#if cam}
					<div data-testid="pf-camera-result">
						{#if cam.works && cam.image}
							<img class="camprev" src={cam.image} alt="Camera test frame" />
						{:else}
							<span class="bad">{cam.message ?? 'No picture'}</span>
						{/if}
					</div>
				{/if}
			{/if}
		</fieldset>

		<label class="chk"
			><input type="checkbox" bind:checked={f.enabled} data-testid="pf-enabled" /> Monitor this printer
			(uncheck to stop monitoring; the print is not affected)</label
		>
	{/if}

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if test}
		<div class="testbox" data-testid="test-result">
			<b class={test.connected ? 'ok' : 'bad'}
				>{test.connected ? 'Connected' : 'Could not connect'}</b
			>
			{#if test.message}<span class="muted"> {test.message}</span>{/if}
			{#if test.status && test.connected}
				<PrinterCard
					printer={{
						name: f.name || 'Printer',
						kind: f.kind,
						enabled: true,
						lastSeenAt: null,
						status: test.status
					}}
				/>
			{/if}
		</div>
	{/if}

	<div class="actions">
		<button class="btn primary" disabled={busy} data-testid="pf-save"
			>{printer ? 'Save' : 'Add printer'}</button
		>
		{#if !isManual}
			<button
				class="btn"
				type="button"
				onclick={runTest}
				disabled={testing || !canTest}
				data-testid="pf-test">{testing ? 'Testing…' : 'Test connection'}</button
			>
		{/if}
		<button class="btn" type="button" onclick={oncancel}>Cancel</button>
	</div>
</form>

<style>
	.pf :global(.form-grid) {
		align-items: start;
	}
	.pf small {
		color: var(--muted);
		font-size: var(--fs-xs);
	}
	.cam {
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		padding: var(--sp-5) var(--sp-6);
		display: grid;
		gap: var(--sp-4);
	}
	.cam legend {
		font-size: var(--fs-sm);
		padding: 0 var(--sp-2);
	}
	.camprev {
		display: block;
		width: 100%;
		max-width: 480px;
		aspect-ratio: 16 / 9;
		object-fit: contain;
		background: #0c0e16; /* camera stage: dark in both themes */
		border-radius: var(--r-md);
	}
	.pf-steps h4 {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-md);
	}
	.pf-steps {
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		padding: var(--sp-5) var(--sp-6);
		background: var(--bg-soft, transparent);
	}
	.pf-steps ol {
		margin: 0 0 var(--sp-4);
		padding-left: 1.3em;
		display: grid;
		gap: var(--sp-3);
		font-size: var(--fs-sm);
	}
	.pf-steps summary {
		cursor: pointer;
		min-height: 24px;
	}
	.pf-tag {
		font-size: var(--fs-xs);
		border: 1px solid var(--line);
		border-radius: var(--r-pill);
		padding: 0 var(--sp-4);
	}
	.hint {
		margin: 0;
		font-size: var(--fs-sm);
	}
	.chk {
		display: flex;
		gap: var(--sp-4);
		align-items: center;
		font-size: var(--fs-md);
	}
	.actions {
		display: flex;
		gap: var(--sp-4);
		flex-wrap: wrap;
	}
	.testbox {
		display: grid;
		gap: var(--sp-4);
	}
	.ok {
		color: var(--ok);
	}
	.bad {
		color: var(--bad);
	}
	.error {
		white-space: normal;
	}
</style>
