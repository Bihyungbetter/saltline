// Builds the serverless web version into docs/ (the folder GitHub Pages serves).
//   node tools/build-static.mjs
// Copies the client and shared modules, the PeerJS browser bundle, and only those
// three.js files the game actually imports (found by following import statements).
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = path.join(ROOT, 'docs');
const THREE = path.join(ROOT, 'node_modules', 'three');
rmSync(OUT, { recursive: true, force: true });
const put = (from, to) => { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); };

const sources = [];
for (const [dir, dest] of [['client', ''], ['shared', 'shared']]) {
  for (const name of readdirSync(path.join(ROOT, dir))) { put(path.join(ROOT, dir, name), path.join(OUT, dest, name)); if (/\.m?js$/.test(name)) sources.push(path.join(ROOT, dir, name)); }
}
put(path.join(ROOT, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'), path.join(OUT, 'vendor', 'peerjs.min.js'));
writeFileSync(path.join(OUT, '.nojekyll'), '');
writeFileSync(path.join(OUT, 'mode.json'), '{"mode":"peers"}\n'); // tells client/net.js there is no race server here

// Follow imports into three.js. `three` and `three/addons/*` mirror the import map in index.html.
const IMPORT = /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g, seen = new Set(), queue = [...sources];
const resolve = (spec, from) => {
  if (spec === 'three') return path.join(THREE, 'build', 'three.module.js');
  if (spec.startsWith('three/addons/')) return path.join(THREE, 'examples', 'jsm', spec.slice('three/addons/'.length));
  if (spec.startsWith('.') && from.startsWith(THREE)) return path.resolve(path.dirname(from), spec);
  return null;                                   // the game's own relative imports were copied above
};
while (queue.length) {
  const file = queue.pop();
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const target = resolve(spec, file);
    if (!target || seen.has(target)) continue;
    if (!existsSync(target)) throw new Error(`${file} imports ${spec}, which was not found`);
    seen.add(target); queue.push(target);
    put(target, path.join(OUT, 'three', path.relative(THREE, target)));
  }
}

let bytes = 0, files = 0;
const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += readFileSync(p).length; } } };
walk(OUT);
console.log(`docs/ built: ${files} files, ${(bytes / 1048576).toFixed(2)} MB, ${seen.size} three.js modules`);
