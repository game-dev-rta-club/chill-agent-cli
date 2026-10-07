import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readWorkspaceTheme,saveWorkspaceTheme} from '../lib/workspace-theme.mjs';
import {themes} from '../public/theme-catalog.js';
test('theme stays with its workspace; invalid input cannot overwrite it',async t=>{
 const a=await mkdtemp(join(tmpdir(),'theme-a-')),b=await mkdtemp(join(tmpdir(),'theme-b-'));t.after(()=>Promise.all([a,b].map(p=>rm(p,{recursive:true,force:true}))));
 assert.deepEqual(await readWorkspaceTheme(a),{theme:'gradient-mint'});
 assert.equal(new Set(themes.map(t=>t.id)).size,18);
 for(const theme of themes){await saveWorkspaceTheme({theme:theme.id},a);assert.equal((await readWorkspaceTheme(a)).theme,theme.id);}
 assert.equal((await readWorkspaceTheme(b)).theme,'gradient-mint');
 for(const input of [{theme:'<script>'},{theme:'dark-mint',remote:true},null])await assert.rejects(saveWorkspaceTheme(input,a));
 assert.equal((await readWorkspaceTheme(a)).theme,'dark-sand');
 await writeFile(join(a,'appearance.json'),JSON.stringify({theme:'removed-theme'}));assert.equal((await readWorkspaceTheme(a)).theme,'gradient-mint');
});

// Exercise the copied package boundary, not only source-tree imports.
test('prepared runtime includes theme catalog and stylesheet',async t=>{
 const {copyRuntime}=await import('../lib/runtime-package.mjs');
 const {pathToFileURL,fileURLToPath}=await import('node:url');
 const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'theme-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await copyRuntime(fileURLToPath(new URL('../',import.meta.url)),root);
 const api=await import(pathToFileURL(join(root,'lib/workspace-theme.mjs')));
 assert.equal((await api.readWorkspaceTheme(join(root,'data'))).theme,'gradient-mint');
 assert.match(await readFile(join(root,'public/themes.css'),'utf8'),/dark-iris/);
});
