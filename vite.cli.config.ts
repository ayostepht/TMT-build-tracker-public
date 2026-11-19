// Bundles the CLI cores into build/cli/ so the production image, which has no
// devDependencies and no TypeScript sources, can run the scripts:
//   src/lib/server/print-geometry/import-cli.ts -> build/cli/geometry-cli.js (scripts/import-print-geometry.mjs)
//   src/lib/server/kitpack/cli.ts               -> build/cli/kitpack-cli.js  (scripts/build-kit-pack.mjs)
// Runs after `vite build` (see the "build" script). Everything, including devDependencies such as
// drizzle-orm and postgres (pruned from the image), is bundled.
import { defineConfig } from 'vite';

export default defineConfig({
	build: {
		ssr: true,
		outDir: 'build/cli',
		emptyOutDir: true,
		target: 'node22',
		rollupOptions: {
			input: {
				'geometry-cli': 'src/lib/server/print-geometry/import-cli.ts',
				'kitpack-cli': 'src/lib/server/kitpack/cli.ts'
			},
			output: { entryFileNames: '[name].js', format: 'esm' }
		}
	},
	ssr: { noExternal: true }
});
