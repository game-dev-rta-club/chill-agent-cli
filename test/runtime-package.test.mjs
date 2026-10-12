import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyRuntime,runtimeFiles} from '../lib/runtime-package.mjs';

test('dependencies hoisted above an installed package are copied to their lockfile paths',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-runtime-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // npm installed the CLI as a dependency: its own dependency sits one level up.
 const root=join(dir,'node_modules/cli');
 for(const d of ['bin','lib','public/vendor','licenses'])await mkdir(join(root,d),{recursive:true});
 for(const f of ['package.json','server.mjs','LICENSE','licenses/tabler-icons.txt','public/vendor/app.js','lib/a.mjs'])await writeFile(join(root,f),f);
 await writeFile(join(root,'npm-shrinkwrap.json'),JSON.stringify({packages:{'':{},'node_modules/dep':{},'node_modules/dep/node_modules/inner':{},'node_modules/tool':{dev:true}}}));
 await mkdir(join(dir,'node_modules/dep/node_modules/inner'),{recursive:true});
 await writeFile(join(dir,'node_modules/dep/index.js'),'hoisted');await writeFile(join(dir,'node_modules/dep/node_modules/inner/index.js'),'nested');
 const files=await runtimeFiles(root);
 assert.ok(files.includes('node_modules/dep/index.js'));assert.ok(files.includes('node_modules/dep/node_modules/inner/index.js'));
 assert.ok(!files.some(f=>f.startsWith('node_modules/tool')),'development dependencies stay out');
 for(const f of files.filter(f=>f.startsWith('public/')))await writeFile(join(root,f),f).catch(()=>{});
 const target=join(dir,'runtime');await mkdir(target);await copyRuntime(root,target);
 assert.equal(await readFile(join(target,'node_modules/dep/index.js'),'utf8'),'hoisted');
 assert.equal(await readFile(join(target,'node_modules/dep/node_modules/inner/index.js'),'utf8'),'nested');
});
