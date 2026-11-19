<script lang="ts">
	/** A hand-made top view of one print plate with parts laid flat. Sample layout, not real data. */
</script>

<figure class="plate">
	<svg
		viewBox="0 0 260 260"
		role="img"
		aria-label="Top view of a square print plate with six numbered parts laid flat, using about seventy percent of the bed."
	>
		<rect class="bed" x="2" y="2" width="256" height="256" rx="6" />
		<g class="grid">
			{#each [54, 106, 158, 210] as p (p)}
				<line x1={p} y1="2" x2={p} y2="258" />
				<line x1="2" y1={p} x2="258" y2={p} />
			{/each}
		</g>
		<rect class="part a" x="16" y="16" width="120" height="64" rx="10" />
		<rect class="part a" x="148" y="16" width="96" height="40" rx="8" />
		<path class="part b" d="M148 70 H244 V120 H196 Q170 120 148 100 Z" />
		<rect class="part a" x="16" y="94" width="84" height="84" rx="12" />
		<ellipse class="part b" cx="168" cy="172" rx="62" ry="36" />
		<rect class="part a" x="16" y="192" width="150" height="46" rx="8" />
		<g class="num">
			<text x="76" y="52" text-anchor="middle">01</text>
			<text x="196" y="40" text-anchor="middle">02</text>
			<text x="204" y="100" text-anchor="middle">03</text>
			<text x="58" y="140" text-anchor="middle">04</text>
			<text x="168" y="176" text-anchor="middle">05</text>
			<text x="91" y="219" text-anchor="middle">06</text>
		</g>
	</svg>
	<figcaption>Plate 3 · 256 × 256 mm bed · 71% used</figcaption>
</figure>

<style>
	.plate {
		margin: 0;
		display: grid;
		gap: var(--sp-5);
	}
	svg {
		display: block;
		width: 100%;
		max-width: 360px;
		height: auto;
	}
	.bed {
		fill: var(--bed);
		stroke: var(--bed-edge);
		stroke-width: 2;
	}
	.grid line {
		stroke: var(--bed-dot);
		stroke-width: 0.75;
		stroke-dasharray: 1 5;
	}
	.part {
		stroke: var(--bed-line);
		stroke-width: 1.5;
	}
	.part.a {
		fill: var(--accent-soft);
		stroke: var(--accent);
	}
	.part.b {
		fill: var(--card);
	}
	.num text {
		font: 500 12px var(--f-mono);
		fill: var(--ink);
	}
	figcaption {
		font: 400 var(--fs-sm) / 1.3 var(--f-mono);
		color: var(--muted);
	}
</style>
