import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyRuntime,runtimeFiles} from '../lib/runtime-package.mjs';

test('dependencies hoisted above an installed package are copied to their lockfile paths',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-runtime-files-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
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

test('every module the runtime imports is copied into it, including subfolders',async()=>{
 const {fileURLToPath}=await import('node:url');const {posix}=await import('node:path');
 const repo=fileURLToPath(new URL('..',import.meta.url));
 const files=new Set(await runtimeFiles(repo));
 assert.ok(files.has('lib/agents/index.mjs'));
 const missing=[];
 for(const file of [...files].filter(f=>/^(bin|lib)\/.*\.mjs$|^server\.mjs$/.test(f))){
  const text=await readFile(join(repo,file),'utf8');
  for(const [,spec] of text.matchAll(/(?:from\s*|import\(\s*)'(\.{1,2}\/[^']+\.mjs)'/g)){
   const target=posix.normalize(posix.join(posix.dirname(file),spec));
   if(!files.has(target))missing.push(`${file} -> ${target}`);
  }
 }
 assert.deepEqual(missing,[]);
});

test('a new package is installed by its own installer, in a separate process',async t=>{
 const {prepareWithOwnInstaller}=await import('../lib/runtime-package.mjs');
 const dir=await mkdtemp(join(tmpdir(),'chill-own-installer-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const root=join(dir,'package');await mkdir(join(root,'lib'),{recursive:true});
 await writeFile(join(root,'lib','runtime-package.mjs'),"export async function prepareRuntime(root,directory,options){return {root:'installed-by-own',from:root,directory,options,pid:process.pid};}");
 const result=await prepareWithOwnInstaller(root,join(dir,'data'),{package:'file:x.tgz'});
 assert.equal(result.root,'installed-by-own');assert.equal(result.from,root);assert.equal(result.directory,join(dir,'data'));
 assert.deepEqual(result.options,{package:'file:x.tgz'});assert.notEqual(result.pid,process.pid);
});

test('the installed runtime starts its Web server',{timeout:60000},async t=>{
 const {fileURLToPath}=await import('node:url');const {spawn}=await import('node:child_process');const {createServer}=await import('node:net');
 const repo=fileURLToPath(new URL('..',import.meta.url));
 const dir=await mkdtemp(join(tmpdir(),'chill-installed-web-'));
 const target=join(dir,'runtime');await mkdir(target);await copyRuntime(repo,target);
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
 const env={...process.env,PORT:String(port),CHILL_AGENT_DATA_DIR:join(dir,'data')};
 const child=spawn(process.execPath,[join(target,'server.mjs')],{cwd:target,env,stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 // Always stop the server, or its open handles keep the whole test run waiting.
 // Stop it before removing its folder: Windows cannot remove a folder a process still uses.
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;}child.stderr.destroy();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
 let status=null;
 for(let i=0;i<100&&status===null&&child.exitCode===null;i++){
  status=await fetch(`http://127.0.0.1:${port}/api/goals`).then(r=>r.status).catch(()=>null);
  if(status===null)await new Promise(r=>setTimeout(r,200));
 }
 assert.equal(status,200,`installed server did not answer: ${stderr.slice(-800)}`);
});

test('installing a new package with its own installer also brings recorded Claude hooks up to it',{timeout:60000},async t=>{
 const {fileURLToPath}=await import('node:url');const {prepareWithOwnInstaller}=await import('../lib/runtime-package.mjs');
 const {configureClaudeHooks,claudeHookGroups}=await import('../lib/claude-setup.mjs');
 const repo=fileURLToPath(new URL('..',import.meta.url));
 const dir=await mkdtemp(join(tmpdir(),'chill-own-installer-hooks-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const project=join(dir,'project'),data=join(dir,'data');await mkdir(project,{recursive:true});
 const entry=join(data,'runtime','chill');
 await configureClaudeHooks(project,{entry,directory:data});
 // An older version did not handle Stop.
 const path=join(project,'.claude','settings.local.json'),settings=JSON.parse(await readFile(path,'utf8'));delete settings.hooks.Stop;await writeFile(path,JSON.stringify(settings));
 const {createHash}=await import('node:crypto');const {realpath}=await import('node:fs/promises');const root=await realpath(project);
 await writeFile(join(data,'settings/claude-projects',`${createHash('sha256').update(root).digest('hex')}.json`),JSON.stringify({project:root,owned:claudeHookGroups({entry}).filter(e=>e.event!=='Stop'),pending:false}));
 // An update also puts the usage mod back in place for the user.
 const {claudeDirectory}=await import('../lib/claude-setup.mjs');const mod=join(claudeDirectory(),'skills','chill-agent-usage');
 await rm(mod,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 const result=await prepareWithOwnInstaller(repo,data);
 assert.deepEqual(result.hooks,[{project:root,changed:true}]);
 assert.equal(JSON.parse(await readFile(path,'utf8')).hooks.Stop.length,1);
 assert.equal(JSON.parse(await readFile(join(mod,'.claude-plugin','plugin.json'),'utf8')).name,'chill-agent-usage');
});
