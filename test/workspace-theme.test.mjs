import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readWorkspaceTheme,saveWorkspaceTheme,appearanceBoot} from '../lib/workspace-theme.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {themes} from '../public/theme-catalog.js';
test('theme stays with its workspace; invalid input cannot overwrite it',async t=>{
 const a=await mkdtemp(join(tmpdir(),'theme-a-')),b=await mkdtemp(join(tmpdir(),'theme-b-'));t.after(()=>Promise.all([a,b].map(p=>rm(p,{recursive:true,force:true}))));
 assert.deepEqual(await readWorkspaceTheme(a),{theme:'gradient-mint',tabIcon:'morning',roots:{}});
 assert.equal(new Set(themes.map(t=>t.id)).size,18);
 for(const theme of themes){await saveWorkspaceTheme({theme:theme.id},a);assert.equal((await readWorkspaceTheme(a)).theme,theme.id);}
 assert.equal((await readWorkspaceTheme(b)).theme,'gradient-mint');
 for(const input of [{theme:'<script>'},{theme:'dark-mint',remote:true},{tabIcon:'sunset'},{},{rootId:'0',theme:'dark-mint'},{reset:true},{rootId:'4',reset:true,theme:'dark-mint'},null])await assert.rejects(saveWorkspaceTheme(input,a));
 assert.equal((await readWorkspaceTheme(a)).theme,'dark-lime');
 await writeFile(join(a,'appearance.json'),JSON.stringify({theme:'removed-theme'}));assert.equal((await readWorkspaceTheme(a)).theme,'gradient-mint');
});

test('a Root keeps its own choice; the project default stays for the rest',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'theme-root-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'appearance.json'),JSON.stringify({theme:'light-ocean'}));
 assert.deepEqual(await readWorkspaceTheme(dir),{theme:'light-ocean',tabIcon:'morning',roots:{}});
 await saveWorkspaceTheme({rootId:'5',tabIcon:'night'},dir);
 await saveWorkspaceTheme({rootId:5,theme:'dark-iris'},dir);
 await saveWorkspaceTheme({tabIcon:'cloudy'},dir);
 assert.deepEqual(await readWorkspaceTheme(dir),{theme:'light-ocean',tabIcon:'cloudy',roots:{'5':{tabIcon:'night',theme:'dark-iris'}}});
 assert.deepEqual(await saveWorkspaceTheme({rootId:'5',reset:true},dir),{theme:'light-ocean',tabIcon:'cloudy',roots:{}});
 await writeFile(join(dir,'appearance.json'),JSON.stringify({theme:'light-ocean',roots:{'6':{theme:'removed'},x:{theme:'dark-iris'},'7':{tabIcon:'night',extra:1}}}));
 assert.deepEqual((await readWorkspaceTheme(dir)).roots,{'7':{tabIcon:'night'}});
});

test('the page picks the open Root\'s look before first paint',async()=>{
 const stored={theme:'gradient-mint',tabIcon:'morning',roots:{'5':{theme:'dark-iris',tabIcon:'night'}}};
 const boot=appearanceBoot(stored,[{id:'5',parentId:null},{id:'6',parentId:'5'},{id:'7',parentId:'6'},{id:'8',parentId:null}]);
 assert.deepEqual(boot.goals,{'5':'5','6':'5','7':'5'});assert.equal(boot.looks['5'].theme,'dark-iris');
 const script=await readFile(new URL('../public/appearance-boot.js',import.meta.url),'utf8');
 const run=hash=>{const html={dataset:{theme:'gradient-mint',tabIcon:'morning'}},attrs={},el=name=>({setAttribute:(k,v)=>{attrs[name]=v;},content:JSON.stringify(boot)});
  vm.runInNewContext(script,{location:{hash},document:{documentElement:html,querySelector:q=>el(q)}});return {...html.dataset,...attrs};};
 assert.deepEqual(run('#/goal/7/activity/12'),{theme:'dark-iris',tabIcon:'night','meta[name="theme-color"]':boot.looks['5'].color,'link[rel="icon"]':boot.looks['5'].icon});
 assert.deepEqual(run('#/goal/8'),{theme:'gradient-mint',tabIcon:'morning'});
 assert.deepEqual(run('#/goals'),{theme:'gradient-mint',tabIcon:'morning'});
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
 assert.match(await readFile(join(root,'public/appearance-boot.js'),'utf8'),/workspace-appearance/);
});
