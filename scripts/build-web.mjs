import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function buildWeb() {
  await mkdir(new URL('../public/vendor/',import.meta.url), {recursive:true});
  await build({entryPoints:[fileURLToPath(new URL('../public/app.js',import.meta.url))], bundle:true, format:'esm', minify:true, external:['/vendor/mermaid.js'], outfile:fileURLToPath(new URL('../public/vendor/workspace-app.js',import.meta.url))});
  await build({entryPoints:[fileURLToPath(new URL('../node_modules/mermaid/dist/mermaid.esm.mjs',import.meta.url))],
    bundle:true, format:'esm', splitting:false, minify:true, legalComments:'external',
    outfile:fileURLToPath(new URL('../public/vendor/mermaid.js',import.meta.url))});
  await copyFile(new URL('../node_modules/mermaid/LICENSE',import.meta.url),new URL('../public/vendor/mermaid.LICENSE',import.meta.url));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb();
