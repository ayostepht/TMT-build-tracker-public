<script lang="ts">
	import { onMount } from 'svelte';
	import ChairViewer from '#lib/components/ChairViewer.svelte';
	import type { TemplateModelInfo } from '#lib/domain/types.ts';

	/**
	 * The real MakeGood chair, rendered by the app's own 3D viewer, for the public home page.
	 * A still image shows first. The viewer (and with it three.js) is only loaded once the box is
	 * near the screen, never on a data-saver connection, and the still fades out when the model is
	 * ready. It turns slowly by itself (not when the visitor prefers reduced motion). It must never
	 * take over page scrolling: on touch screens it ignores touches, and a mouse wheel over it
	 * scrolls the page instead of zooming. Dragging with a mouse still turns the chair.
	 */
	let {
		model,
		partRoles,
		hidden = [],
		palette,
		poster,
		alt
	}: {
		model: TemplateModelInfo | null;
		/** part slug → color role key */
		partRoles: Record<string, string>;
		/** slugs of variant parts that are not drawn (the template's non-default options) */
		hidden?: string[];
		/** role key → hex */
		palette: Record<string, string>;
		poster: string;
		alt: string;
	} = $props();

	let box = $state<HTMLDivElement>();
	let live = $state(false);
	let ready = $state(false);
	let still = $state(false);

	const colors = $derived(
		Object.fromEntries(Object.entries(partRoles).map(([slug, role]) => [slug, palette[role]]))
	);

	onMount(() => {
		const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
		if (!model || conn?.saveData || !('IntersectionObserver' in window)) return;
		still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					live = true;
					io.disconnect();
				}
			},
			{ rootMargin: '300px' }
		);
		if (box) io.observe(box);
		// A wheel over the chair scrolls the page: keep it away from the viewer's zoom.
		const noZoom = (e: Event) => e.stopPropagation();
		box?.addEventListener('wheel', noZoom, { capture: true });
		return () => {
			io.disconnect();
			box?.removeEventListener('wheel', noZoom, { capture: true });
		};
	});
</script>

<div class="hc-clip">
	<div class="hc-box" bind:this={box}>
		<img class="hc-still" class:hc-gone={ready} src={poster} {alt} width="1120" height="1240" />
		{#if live && model}
			<div class="hc-live" aria-hidden="true">
				<ChairViewer
					{model}
					{colors}
					{hidden}
					autoRotate={!still}
					showHardware={false}
					quiet
					onready={() => (ready = true)}
				></ChairViewer>
			</div>
		{/if}
	</div>
</div>

<style>
	/* The model is framed with generous margins; the clip crops them so the chair fills the box. */
	.hc-clip {
		position: relative;
		overflow: hidden;
		width: 100%;
		aspect-ratio: 1 / 1.08;
	}
	.hc-box {
		position: absolute;
		left: -7.5%;
		top: 50%;
		width: 115%;
		transform: translateY(-50%);
		aspect-ratio: 1120 / 1240;
		min-width: 0;
	}
	.hc-still,
	.hc-live {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.hc-still {
		object-fit: contain;
		transition: opacity 0.5s ease;
	}
	.hc-gone {
		opacity: 0;
	}
	.hc-live :global(.chair-viewer) {
		min-height: 0;
	}
	/* a finger on the chair is a scroll, not a turn */
	@media (pointer: coarse) {
		.hc-live {
			pointer-events: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.hc-still {
			transition: none;
		}
	}
</style>
