import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('node_modules/occt-import-js/dist');
const target = resolve('public/occt');
mkdirSync(target, { recursive: true });
for (const name of ['occt-import-js.js', 'occt-import-js.wasm', 'license.occt-import-js.txt', 'license.occt.txt']) {
  copyFileSync(resolve(source, name), resolve(target, name));
}
console.log('Copied the local OpenCascade STEP importer into public/occt.');
