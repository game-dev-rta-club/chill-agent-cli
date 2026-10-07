import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {prepareRuntime} from '../lib/runtime-package.mjs';
import {configureClaudeHooks,claudeSetupStatus} from '../lib/claude-setup.mjs';
const execute=promisify(execFile);
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-claude-setup-')),project=join(dir,"project ' one"),data=join(dir,"data ' one");await mkdir(project);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(project,'.claude/settings.local.json'),options={directory:data,launcher:join(data,"runtime ' one/chill.mjs")};
 const config={permissions:{allow:['Read'],deny:['Bash(rm *)']},env:{EXISTING:'keep'},hooks:{PostToolUse:[{matcher:'Read',hooks:[{type:'command',command:'echo other'}]}]}};
 await mkdir(join(project,'.claude'));await writeFile(path,JSON.stringify(config));
 return {dir,project,data,path,options,config,read:async()=>JSON.parse(await readFile(path,'utf8'))};
}
test('native setup is additive, idempotent and removable without changing permissions or other hooks',async t=>{
 const f=await fixture(t);const first=await configureClaudeHooks(f.project,f.options);assert(first.configured&&first.changed);assert.equal(first.idleWatchMs,null);
 let config=await f.read();assert.deepEqual(config.permissions,f.config.permissions);assert.deepEqual(config.env,f.config.env);assert.deepEqual(config.hooks.PostToolUse[0],f.config.hooks.PostToolUse[0]);
 assert.match(config.hooks.SessionStart[0].hooks[0].command,/'\\''/);assert.equal(config.hooks.Stop.length,1);
 assert.equal((await configureClaudeHooks(f.project,f.options)).changed,false);
 await configureClaudeHooks(f.project,{...f.options,idleWatchMs:5000});config=await f.read();assert.equal(config.hooks.Stop.length,2);assert.equal(config.hooks.Stop[1].hooks[0].asyncRewake,true);assert.equal(config.hooks.Stop[1].hooks[0].timeout,10);assert.equal(config.hooks.SessionStart[1].matcher,'resume');assert.equal(config.hooks.SessionStart[1].hooks[0].asyncRewake,true);
 await configureClaudeHooks(f.project,f.options);assert.equal((await f.read()).hooks.Stop.length,1);
 await configureClaudeHooks(f.project,{...f.options,remove:true});assert.deepEqual(await f.read(),f.config);assert.equal((await claudeSetupStatus(f.project,f.options)).configured,false);
});
test('edited, foreign and symlinked hooks fail closed while native hook disablement is preserved',async t=>{
 const f=await fixture(t);await writeFile(f.path,JSON.stringify({...f.config,disableAllHooks:true}));
 assert.equal((await configureClaudeHooks(f.project,f.options)).locallyDisabled,true);
 await assert.rejects(configureClaudeHooks(f.project,{...f.options,directory:join(f.dir,'other-data')}),/untracked or edited/);
 const edited=await f.read();edited.hooks.Stop[0].hooks[0].timeout=19;await writeFile(f.path,JSON.stringify(edited));
 assert.equal((await claudeSetupStatus(f.project,f.options)).conflict,true);
 await assert.rejects(configureClaudeHooks(f.project,{...f.options,remove:true}),/untracked or edited/);assert.deepEqual(await f.read(),edited);
 await rm(f.path);const target=join(f.dir,'outside.json');await writeFile(target,'{}');await symlink(target,f.path);
 await assert.rejects(configureClaudeHooks(f.project,f.options),/symlink/);assert.equal(await readFile(target,'utf8'),'{}');
});
test('concurrent prepares do not duplicate; malformed settings and durations do not overwrite files',async t=>{
 const f=await fixture(t);await Promise.all([configureClaudeHooks(f.project,f.options),configureClaudeHooks(f.project,f.options)]);assert.equal((await f.read()).hooks.Stop.length,1);
 await assert.rejects(configureClaudeHooks(f.project,{...f.options,idleWatchMs:0}),/duration/);
 await writeFile(f.path,'{"hooks":{"Stop":"invalid"}}');await assert.rejects(configureClaudeHooks(f.project,f.options),/Invalid Claude hook groups/);
 assert.equal(await readFile(f.path,'utf8'),'{"hooks":{"Stop":"invalid"}}');
});

test('extended watches configure the native timeout too, without granting native tools',async t=>{
 const f=await fixture(t);
 for(const idleWatchMs of [43200000,86400000]){
  const configured=await configureClaudeHooks(f.project,{...f.options,idleWatchMs});
  assert.equal(configured.idleWatchMs,idleWatchMs);
  const config=await f.read(),watch=config.hooks.Stop[1].hooks[0];
  assert.match(watch.command,new RegExp(`--timeout-ms ${idleWatchMs}$`));
  assert.equal(watch.timeout,idleWatchMs/1000+5);assert.equal(watch.asyncRewake,true);
  assert.deepEqual(config.permissions,f.config.permissions);
 }
 const before=await f.read();
 for(const idleWatchMs of [86400001,Infinity,NaN,1000.5])await assert.rejects(configureClaudeHooks(f.project,{...f.options,idleWatchMs}),/duration/);
 assert.deepEqual(await f.read(),before);
});
test('an interrupted ownership commit can reconcile either settings version without duplicates',async t=>{
 const f=await fixture(t);await configureClaudeHooks(f.project,f.options);
 const records=join(f.data,'settings/claude-projects'),path=join(records,(await readdir(records))[0]),old=JSON.parse(await readFile(path,'utf8'));
 await writeFile(path,JSON.stringify({...old,pending:true}));
 assert.equal((await claudeSetupStatus(f.project,f.options)).configured,false);
 await configureClaudeHooks(f.project,f.options);assert.equal((await f.read()).hooks.Stop.length,1);
 await writeFile(path,JSON.stringify({...old,pending:true}));await writeFile(f.path,JSON.stringify(f.config));
 assert.equal((await configureClaudeHooks(f.project,f.options)).configured,true);assert.equal((await f.read()).hooks.Stop.length,1);
});
test('CLI prepares native hooks with no Codex executable, and status never claims native activation',async t=>{
 const f=await fixture(t),entry=new URL('../bin/chill-setup.mjs',import.meta.url).pathname;
 const env={...process.env,CHILL_AGENT_DATA_DIR:f.data,CHILL_AGENT_CODEX_PATH:'/never/call/codex'};
 const run=(...args)=>execute(process.execPath,[entry,...args],{env,timeout:15000});
  const prepared=JSON.parse((await run('prepare','--harness','claude-code','--project',f.project,'--idle-watch-ms','43200000')).stdout);assert(prepared.hook.configured);assert.equal(prepared.codex,undefined);
  assert.equal(prepared.hook.idleWatchMs,43200000);assert.equal((await f.read()).hooks.Stop[1].hooks[0].timeout,43205);
  const readContext=async(root,directory)=>{
    const code=`import {feedbackContext} from ${JSON.stringify(pathToFileURL(join(root,'lib/claude-actions.mjs')).href)};console.log(feedbackContext([]));`;
    return (await execute(process.execPath,['--input-type=module','-e',code],{env:{...env,CHILL_AGENT_DATA_DIR:directory},timeout:10000})).stdout;
  };
  const firstContext=await readContext(prepared.root,prepared.dataDirectory);
  assert(firstContext.includes(prepared.command+' connection activity'));
  assert(firstContext.includes(prepared.command+' goal show'));
  assert(!firstContext.includes('/packages/'));
  // A runtime update must not change the suggested command, even for an old hook.
  await writeFile(join(prepared.root,'lib/probe-revision.mjs'),'export const revision=2;');
  const updated=await prepareRuntime(prepared.root,prepared.dataDirectory);
  assert.notEqual(updated.id,prepared.id);
  assert.equal(await readContext(updated.root,prepared.dataDirectory),firstContext);
  assert.equal(await readContext(prepared.root,prepared.dataDirectory),firstContext);
  const foreign=await readContext(prepared.root,join(f.dir,'different-store'));
  assert(foreign.includes('/bin/chill-entry.mjs'));assert(!foreign.includes('/runtime/chill.mjs'));
  // The exact quoted prefix is executable, including a path containing an apostrophe.
  const help=execFileSync('/bin/sh',['-c',prepared.command+' connection --help'],{encoding:'utf8'});
  assert.match(help,/connection/);
 const envFile=join(f.dir,'native-env');await writeFile(envFile,'');const hook=(await f.read()).hooks.SessionStart[0].hooks[0];
 execFileSync('/bin/sh',['-c',hook.command],{cwd:f.project,env:{...env,CLAUDE_ENV_FILE:envFile},input:JSON.stringify({hook_event_name:'SessionStart',source:'resume',session_id:'native-test',cwd:f.project}),encoding:'utf8'});
 assert.match(await readFile(envFile,'utf8'),/CHILL_AGENT_SESSION_ID='native-test'/);
 const status=JSON.parse((await run('status','--harness','claude-code','--project',f.project)).stdout);assert.match(status.activation,/Not verified/);
 assert.deepEqual((await f.read()).permissions,f.config.permissions);
 await run('remove','--harness','claude-code','--project',f.project);assert.deepEqual(await f.read(),f.config);
});
