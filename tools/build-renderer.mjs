import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const renderer = path.join(root, 'src', 'renderer');
const vendor = path.join(renderer, 'vendor');

await mkdir(vendor, { recursive: true });
await copyFile(
  path.join(root, 'node_modules', 'spessasynth_lib', 'dist', 'spessasynth_processor.min.js'),
  path.join(vendor, 'spessasynth_processor.min.js')
);

await build({
  entryPoints: [path.join(renderer, 'app-src.js')],
  outfile: path.join(renderer, 'app.bundle.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome128'],
  sourcemap: false,
  minify: false,
  logLevel: 'info'
});
