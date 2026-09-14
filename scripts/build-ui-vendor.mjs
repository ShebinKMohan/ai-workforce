import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  stdin: { contents: 'export { animate } from "motion/mini";', resolveDir: root, sourcefile: 'motion-entry.js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  outfile: fileURLToPath(new URL('../web/headquarters/src/headquarters/assets/motion.js', import.meta.url)),
  legalComments: 'inline', banner: { js: '/* Motion 13.2.0 · MIT · motion.dev · bundled locally by scripts/build-ui-vendor.mjs */' },
});
writeFileSync(new URL('../web/headquarters/src/headquarters/assets/MOTION-LICENSE.txt', import.meta.url), readFileSync(new URL('../node_modules/motion/LICENSE.md', import.meta.url)));
