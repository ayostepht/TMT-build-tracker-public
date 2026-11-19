<script lang="ts">
	/**
	 * A hand-drawn side view of a toddler mobility trainer, in four filament roles. It is an
	 * illustration (no MakeGood model data), so the public pages need no model files. The fills
	 * are the colors a maker picked; the outline follows the theme ink.
	 */
	let {
		primary = '#2f5d62',
		accent = '#e0a458',
		soft = '#efe6d2',
		tire = '#3a3631',
		callouts = false
	}: {
		primary?: string;
		accent?: string;
		soft?: string;
		tire?: string;
		/** Numbered leader lines, matched by a list next to the drawing. */
		callouts?: boolean;
	} = $props();
</script>

<svg
	class="chair"
	viewBox="0 0 400 280"
	role="img"
	aria-label="Side view of a toddler mobility trainer: a seat with a high back, a push handle behind, a footrest in front and four wheels."
	style="--c-primary:{primary};--c-accent:{accent};--c-soft:{soft};--c-tire:{tire}"
>
	<!-- ground -->
	<line class="ground" x1="12" y1="251" x2="388" y2="251" />
	<!-- push handle -->
	<path class="stroke-fill soft" d="M124 74 L58 60 L50 108 L66 110 L70 78 L128 90 Z" />
	<!-- back -->
	<path class="stroke-fill primary" d="M126 150 L116 68 L152 62 L170 150 Z" />
	<!-- headrest -->
	<rect class="stroke-fill soft" x="108" y="42" width="52" height="26" rx="9" />
	<!-- frame and base -->
	<rect class="stroke-fill primary" x="98" y="172" width="232" height="16" rx="5" />
	<!-- seat cushion -->
	<rect class="stroke-fill accent" x="128" y="148" width="158" height="26" rx="8" />
	<!-- wing -->
	<path class="stroke-fill accent" d="M152 104 Q214 92 250 128 L252 148 L160 148 Z" />
	<!-- footrest -->
	<path class="stroke-fill primary" d="M284 176 L320 202 L306 214 L270 188 Z" />
	<rect class="stroke-fill accent" x="304" y="200" width="56" height="12" rx="4" />
	<!-- rear wheel -->
	<circle class="tire" cx="112" cy="217" r="30" />
	<circle class="stroke-fill soft" cx="112" cy="217" r="20" />
	<circle class="hub" cx="112" cy="217" r="5" />
	<!-- front wheel -->
	<circle class="tire" cx="300" cy="224" r="23" />
	<circle class="stroke-fill soft" cx="300" cy="224" r="14" />
	<circle class="hub" cx="300" cy="224" r="4" />
	<path class="stroke-fill primary" d="M104 188 L120 188 L118 200 L106 200 Z" />
	<path class="stroke-fill primary" d="M294 188 L308 188 L306 206 L296 206 Z" />

	{#if callouts}
		<g class="callouts">
			<path d="M134 42 L134 18" />
			<path d="M146 108 L186 28 L186 22" />
			<path d="M206 160 L206 232" />
			<path d="M226 120 L262 78 L296 78" />
			<path d="M336 206 L372 170" />
			<path d="M54 80 L30 80" />
			<g class="tag"
				><circle cx="134" cy="14" r="9" /><text x="134" y="18" text-anchor="middle">1</text></g
			>
			<g class="tag"
				><circle cx="186" cy="14" r="9" /><text x="186" y="18" text-anchor="middle">2</text></g
			>
			<g class="tag"
				><circle cx="206" cy="238" r="9" /><text x="206" y="242" text-anchor="middle">3</text></g
			>
			<g class="tag"
				><circle cx="305" cy="78" r="9" /><text x="305" y="82" text-anchor="middle">4</text></g
			>
			<g class="tag"
				><circle cx="376" cy="164" r="9" /><text x="376" y="168" text-anchor="middle">5</text></g
			>
			<g class="tag"
				><circle cx="21" cy="80" r="9" /><text x="21" y="84" text-anchor="middle">6</text></g
			>
		</g>
	{/if}
</svg>

<style>
	.chair {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}
	.chair :global(.stroke-fill) {
		stroke: var(--ink);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.primary {
		fill: var(--c-primary);
	}
	.accent {
		fill: var(--c-accent);
	}
	.soft {
		fill: var(--c-soft);
	}
	.tire {
		fill: var(--c-tire);
		stroke: var(--ink);
		stroke-width: 2;
	}
	.hub {
		fill: var(--ink);
	}
	.ground {
		stroke: var(--muted);
		stroke-width: 1.5;
		stroke-dasharray: 2 5;
	}
	.callouts path {
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.25;
	}
	.tag circle {
		fill: var(--card);
		stroke: var(--ink);
		stroke-width: 1.25;
	}
	.tag text {
		font: 500 11px var(--f-mono);
		fill: var(--ink);
	}
</style>
