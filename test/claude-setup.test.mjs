import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {prepareRuntime} from '../lib/runtime-package.mjs';
import {configureClaudeHooks,claudeSetupStatus,findGitBash,claudeWatcherInstalled} from '../lib/claude-setup.mjs';
import {claudeHook} from './claude-fixtures.mjs';
const execute=promisify(execFile);
// Claude Code runs Bash commands and shell-form hooks with sh, or Git Bash on Windows.
const posixShell=()=>process.platform==='win32'?findGitBash():'/bin/sh';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-claude-setup-')),project=join(dir,"project ' one"),data=join(dir,"data ' one");await mkdir(project);
 t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const path=join(project,'.claude/settings.local.json'),options={directory:data,entry:join(data,"runtime ' one/chill")};
 const config={permissions:{allow:['Read'],deny:['Bash(rm *)']},env:{EXISTING:'keep'},hooks:{PostToolUse:[{matcher:'Read',hooks:[{type:'command',command:'echo other'}]}]}};
 await mkdir(join(project,'.claude'));await writeFile(path,JSON.stringify(config));
 return {dir,project,data,path,options,config,read:async()=>JSON.parse(await readFile(path,'utf8'))};
}
test('native setup is additive, idempotent and removable without changing permissions or other hooks',async t=>{
 const f=await fixture(t);const first=await configureClaudeHooks(f.project,f.options);assert(first.configured&&first.changed);
 let config=await f.read();assert.deepEqual(config.permissions,f.config.permissions);assert.deepEqual(config.env,f.config.env);assert.deepEqual(config.hooks.PostToolUse[0],f.config.hooks.PostToolUse[0]);
 assert.match(config.hooks.SessionStart[0].hooks[0].command,/'\\''/);assert.equal(config.hooks.Stop.length,1);
 assert.equal((await configureClaudeHooks(f.project,f.options)).changed,false);
 await configureClaudeHooks(f.project,{...f.options,remove:true});assert.deepEqual(await f.read(),f.config);assert.equal((await claudeSetupStatus(f.project,f.options)).configured,false);
});
test('edited and foreign chill hooks are replaced, a person\'s hook in their group stays, and symlinked settings fail closed',{skip:process.platform==='win32'&&'creating symlinks needs Windows Developer Mode'},async t=>{
 const f=await fixture(t);await writeFile(f.path,JSON.stringify({...f.config,disableAllHooks:true}));
 assert.equal((await configureClaudeHooks(f.project,f.options)).locallyDisabled,true);
 // Another store's setup takes over the project's chill hooks without duplicates.
 await configureClaudeHooks(f.project,{...f.options,directory:join(f.dir,'other-data')});
 await configureClaudeHooks(f.project,f.options);assert.equal((await f.read()).hooks.Stop.length,1);
 const edited=await f.read();edited.hooks.Stop[0].hooks[0].timeout=19;edited.hooks.Stop[0].hooks.push({type:'command',command:'echo mine'});await writeFile(f.path,JSON.stringify(edited));
 assert.equal((await claudeSetupStatus(f.project,f.options)).configured,false);
 const fixed=await configureClaudeHooks(f.project,f.options);assert(fixed.configured&&fixed.changed);
 const stop=(await f.read()).hooks.Stop;
 assert.deepEqual(stop.flatMap(g=>g.hooks).filter(h=>/claude-hook$/.test(h.command)).map(h=>h.timeout),[15],'the edited chill hook is put back');
 assert.equal(stop.flatMap(g=>g.hooks).filter(h=>h.command==='echo mine').length,1,'the person\'s hook stays');
 await configureClaudeHooks(f.project,{...f.options,remove:true});
 assert.deepEqual((await f.read()).hooks.Stop,[{hooks:[{type:'command',command:'echo mine'}]}],'remove takes only chill\'s hooks');
 await rm(f.path);const target=join(f.dir,'outside.json');await writeFile(target,'{}');await symlink(target,f.path);
 await assert.rejects(configureClaudeHooks(f.project,f.options),/symlink/);assert.equal(await readFile(target,'utf8'),'{}');
});
test('concurrent prepares do not duplicate; malformed settings do not overwrite files',async t=>{
 const f=await fixture(t);const both=await Promise.all([configureClaudeHooks(f.project,f.options),configureClaudeHooks(f.project,f.options)]);assert.equal((await f.read()).hooks.Stop.length,1);
 assert.deepEqual(both.map(s=>s.cacheKeep.error),[undefined,undefined],'both place Cache Keep');
 await writeFile(f.path,'{"hooks":{"Stop":"invalid"}}');await assert.rejects(configureClaudeHooks(f.project,f.options),/Invalid Claude hook groups/);
 assert.equal(await readFile(f.path,'utf8'),'{"hooks":{"Stop":"invalid"}}');
});

test('a deleted settings file gets chill\'s hooks again on the next update',async t=>{
 const {refreshRecordedClaudeHooks}=await import('../lib/claude-setup.mjs');
 const f=await fixture(t);await configureClaudeHooks(f.project,f.options);
 await rm(f.path);
 assert.deepEqual((await refreshRecordedClaudeHooks(f.options)).map(r=>r.changed),[true]);
 assert.equal((await claudeSetupStatus(f.project,f.options)).configured,true);assert.equal((await f.read()).hooks.Stop.length,1);
});
test('CLI prepares native hooks with no Codex executable, and status never claims native activation',async t=>{
 const f=await fixture(t),entry=fileURLToPath(new URL('../bin/chill-setup.mjs',import.meta.url));
 const env={...process.env,CHILL_AGENT_DATA_DIR:f.data,CHILL_AGENT_CODEX_PATH:'/never/call/codex'};
 // Copying the runtime takes longer on Windows while other tests run.
 const run=(...args)=>execute(process.execPath,[entry,...args],{env,timeout:60000});
  const prepared=JSON.parse((await run('prepare','--harness','claude-code','--project',f.project)).stdout);assert(prepared.hook.configured);assert.equal(prepared.codex,undefined);
  const readContext=async(root,directory)=>{
    const code=`import {claudeFeedbackText} from ${JSON.stringify(pathToFileURL(join(root,'lib/claude-actions.mjs')).href)};console.log(await claudeFeedbackText([]));`;
    return (await execute(process.execPath,['--input-type=module','-e',code],{env:{...env,CHILL_AGENT_DATA_DIR:directory},timeout:10000})).stdout;
  };
  const firstContext=await readContext(prepared.root,prepared.dataDirectory);
  assert(firstContext.includes(prepared.command+' connection reply --goal <goalId>'));
  assert(firstContext.includes("add --ask '<what to decide>'; it then appears as a Letter."));
  assert.equal(prepared.command,`'${prepared.entry.replaceAll("'","'\\''")}'`,'installed hooks and agents use the short entry');
  assert(!firstContext.includes('/packages/'));
  // A runtime update must not change the suggested command, even for an old hook.
  await writeFile(join(prepared.root,'lib/probe-revision.mjs'),'export const revision=2;');
  const updated=await prepareRuntime(prepared.root,prepared.dataDirectory);
  assert.notEqual(updated.id,prepared.id);
  assert.equal(await readContext(updated.root,prepared.dataDirectory),firstContext);
  assert.equal(await readContext(prepared.root,prepared.dataDirectory),firstContext);
  const foreign=await readContext(prepared.root,join(f.dir,'different-store'));
  assert.match(foreign,/[\\/]bin[\\/]chill-entry\.mjs/);assert.doesNotMatch(foreign,/[\\/]runtime[\\/]chill\.mjs/);
  // The exact quoted prefix is executable, including a path containing an apostrophe.
  const help=execFileSync(posixShell(),['-c',prepared.command+' connection --help'],{encoding:'utf8',env:{...env,CHILL_AGENT_DATA_DIR:prepared.dataDirectory}});
  assert.match(help,/connection/);
 const envFile=join(f.dir,'native-env');await writeFile(envFile,'');const hook=(await f.read()).hooks.SessionStart[0].hooks[0];
 const options={cwd:f.project,env:{...env,CLAUDE_ENV_FILE:envFile},input:JSON.stringify(claudeHook('SessionStart',{source:'resume',session_id:'native-test',cwd:f.project})),encoding:'utf8'};
 execFileSync(posixShell(),['-c',hook.command],options);
 assert.match(await readFile(envFile,'utf8'),/CHILL_AGENT_SESSION_ID='native-test'/);
 const status=JSON.parse((await run('status','--harness','claude-code','--project',f.project)).stdout);assert.match(status.activation,/Not verified/);
 assert.deepEqual((await f.read()).permissions,f.config.permissions);
 await run('remove','--harness','claude-code','--project',f.project);assert.deepEqual(await f.read(),f.config);
});

test('an exec-form hook from an earlier Windows setup is replaced by the shell form',async t=>{
 const f=await fixture(t);await configureClaudeHooks(f.project,f.options);
 const records=join(f.data,'settings/claude-projects'),record=join(records,(await readdir(records))[0]);
 const old=JSON.parse(await readFile(record,'utf8')),config=await f.read();
 const exec=group=>({...group,hooks:group.hooks.map(({command,...hook})=>({type:hook.type,command:'C:/node/node.exe',args:['C:/data/runtime/chill.mjs','connection','claude-hook'],timeout:hook.timeout,statusMessage:hook.statusMessage}))});
 for(const entry of old.owned){config.hooks[entry.event]=config.hooks[entry.event].map(g=>g.hooks[0].command===entry.group.hooks[0].command?exec(g):g);entry.group=exec(entry.group);}
 await writeFile(f.path,JSON.stringify(config));await writeFile(record,JSON.stringify(old));
 assert.equal((await configureClaudeHooks(f.project,f.options)).configured,true);
 const hooks=Object.values((await f.read()).hooks).flat().flatMap(g=>g.hooks);
 assert.equal(hooks.filter(h=>h.args).length,0);assert.equal(hooks.filter(h=>/ connection claude-hook$/.test(h.command)).length,10);
 // The watcher runs in the background from SessionStart and Stop and wakes the model itself.
 const watchers=Object.entries((await f.read()).hooks).flatMap(([event,groups])=>groups.flatMap(g=>g.hooks.filter(h=>/ connection claude-watch$/.test(h.command)).map(h=>({event,...h}))));
 assert.deepEqual(watchers.map(h=>[h.event,h.asyncRewake,h.timeout]),[['SessionStart',true,604800],['Stop',true,604800]]);
 assert.equal(await claudeWatcherInstalled(f.project),true);
 // An unrecorded exec-form chill hook is replaced too.
 const foreign=await f.read();foreign.hooks.Stop.push(exec(foreign.hooks.Stop.find(g=>/claude-hook/.test(g.hooks[0].command))));await writeFile(f.path,JSON.stringify(foreign));
 assert.equal((await claudeSetupStatus(f.project,f.options)).configured,false);
 await configureClaudeHooks(f.project,f.options);assert.equal((await f.read()).hooks.Stop.length,1);
});

test('Git Bash is found as Claude Code finds it: the override, then above git on PATH',()=>{
 const files=new Set(['C:\\Program Files\\Git\\cmd\\git.exe','C:\\Program Files\\Git\\bin\\bash.exe','D:\\bash\\bash.exe']),exists=p=>files.has(p);
 assert.equal(findGitBash({env:{PATH:'C:\\Windows;C:\\Program Files\\Git\\cmd'},exists}),'C:\\Program Files\\Git\\bin\\bash.exe');
 assert.equal(findGitBash({env:{Path:'C:\\Program Files\\Git\\cmd'},exists}),'C:\\Program Files\\Git\\bin\\bash.exe');
 assert.equal(findGitBash({env:{CLAUDE_CODE_GIT_BASH_PATH:'D:\\bash\\bash.exe',PATH:''},exists}),'D:\\bash\\bash.exe');
 assert.equal(findGitBash({env:{CLAUDE_CODE_GIT_BASH_PATH:'D:\\missing\\bash.exe',PATH:'C:\\Program Files\\Git\\cmd'},exists}),null);
 assert.equal(findGitBash({env:{PATH:'C:\\Windows'},exists}),null);
});

test('an update brings recorded hooks up to the new version, puts back edited ones and leaves other hooks and removed setups alone',async t=>{
 const {refreshRecordedClaudeHooks,claudeHookGroups}=await import('../lib/claude-setup.mjs');
 const f=await fixture(t);
 await configureClaudeHooks(f.project,f.options);
 // Simulate a project set up by an older version that handled fewer events.
 const {createHash}=await import('node:crypto');const {realpath}=await import('node:fs/promises');
 const record=join(f.data,'settings/claude-projects',`${createHash('sha256').update(await realpath(f.project)).digest('hex')}.json`);
 const older=claudeHookGroups(f.options).filter(e=>e.event!=='PermissionRequest');
 const settings=await f.read();delete settings.hooks.PermissionRequest;await writeFile(f.path,JSON.stringify(settings));
 await writeFile(record,JSON.stringify({project:await realpath(f.project),owned:older,pending:false}));
 const results=await refreshRecordedClaudeHooks(f.options);
 assert.deepEqual(results.map(r=>r.changed),[true]);
 const updated=await f.read();
 assert.equal(updated.hooks.PermissionRequest.length,1,'the newly handled event is added');
 assert.deepEqual(updated.permissions,f.config.permissions);assert.equal(updated.hooks.PostToolUse.filter(g=>g.matcher==='Read').length,1,'other hooks are kept');
 assert.deepEqual((await refreshRecordedClaudeHooks(f.options)).map(r=>r.changed),[false],'a second update changes nothing');
 // A hand-edited chill hook is put back.
 const edited=await f.read();edited.hooks.Stop[0].hooks[0].timeout=99;await writeFile(f.path,JSON.stringify(edited));
 assert.deepEqual((await refreshRecordedClaudeHooks(f.options)).map(r=>r.changed),[true]);assert.equal((await f.read()).hooks.Stop[0].hooks[0].timeout,15);
 // A project whose hooks were removed is not set up again.
 await configureClaudeHooks(f.project,{...f.options,remove:true});
 assert.deepEqual(await refreshRecordedClaudeHooks(f.options),[]);
 assert.equal((await f.read()).hooks?.SessionStart,undefined);
});

test('hooks rewritten with their keys in another order still count as chill\'s and are refreshed',async t=>{
 const {refreshRecordedClaudeHooks,cacheKeepPlugin}=await import('../lib/claude-setup.mjs');
 const f=await fixture(t);
 await configureClaudeHooks(f.project,f.options);
 const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverse(v[k])])):v;
 const settings=await f.read();delete settings.enabledPlugins;settings.hooks=reverse(settings.hooks);await writeFile(f.path,JSON.stringify(settings));
 assert.equal((await claudeSetupStatus(f.project,{directory:f.data})).configured,true);
 const [result]=await refreshRecordedClaudeHooks(f.options);
 assert.equal(result.error,undefined);
 assert.equal((await f.read()).enabledPlugins?.[cacheKeepPlugin],true,'the update turns Cache Keep on again');
});

test('setup places Cache Keep for the user, off there and on in the project; remove takes back only its on',async t=>{
 const {cacheKeepPlugin}=await import('../lib/claude-setup.mjs');
 const f=await fixture(t),claude=join(f.dir,'claude'),options={...f.options,claude};
 const user=async()=>JSON.parse(await readFile(join(claude,'settings.json'),'utf8'));
 await mkdir(claude);await writeFile(join(claude,'settings.json'),JSON.stringify({theme:'dark'}));
 const first=await configureClaudeHooks(f.project,options);
 assert.equal(first.cacheKeep.enabled,true);
 assert.deepEqual(await user(),{theme:'dark',enabledPlugins:{[cacheKeepPlugin]:false}},'off for the user, other settings kept');
 const mod=join(claude,'skills','chill-agent-cache-keep');
 assert.equal(JSON.parse(await readFile(join(mod,'.claude-plugin/plugin.json'),'utf8')).name,'chill-agent-cache-keep');
 assert.deepEqual((await readdir(join(mod,'hooks'))).sort(),['hooks.json','register.ts'],'the tests stay in the repository');
 assert.deepEqual((await readdir(join(claude,'skills'))),['chill-agent-cache-keep'],'no staging folder is left');
 assert.equal((await f.read()).enabledPlugins[cacheKeepPlugin],true,'on in the project');
 // The person's own choice for the user stays, and an update replaces the mod.
 await writeFile(join(claude,'settings.json'),JSON.stringify({enabledPlugins:{[cacheKeepPlugin]:true}}));
 await writeFile(join(mod,'hooks/register.ts'),'stale');
 assert.equal((await configureClaudeHooks(f.project,options)).changed,false);
 assert.deepEqual(await user(),{enabledPlugins:{[cacheKeepPlugin]:true}});
 assert.notEqual(await readFile(join(mod,'hooks/register.ts'),'utf8'),'stale');
 await configureClaudeHooks(f.project,{...options,remove:true});
 assert.deepEqual(await f.read(),f.config,'removing chill takes back its on');
 // An off the person set in the project is kept through setup and removal.
 const off={...f.config,enabledPlugins:{[cacheKeepPlugin]:false}};await writeFile(f.path,JSON.stringify(off));
 await configureClaudeHooks(f.project,options);assert.equal((await f.read()).enabledPlugins[cacheKeepPlugin],false);
 await configureClaudeHooks(f.project,{...options,remove:true});assert.deepEqual(await f.read(),off);
});

test('unreadable user settings leave Cache Keep off and the hooks set up',async t=>{
 const f=await fixture(t),claude=join(f.dir,'claude');
 await mkdir(claude);await writeFile(join(claude,'settings.json'),'{not json');
 const status=await configureClaudeHooks(f.project,{...f.options,claude});
 assert(status.configured);assert.equal(status.cacheKeep.enabled,false);assert.match(status.cacheKeep.error,/JSON/);
 assert.equal((await f.read()).enabledPlugins,undefined);
 assert.equal(await readFile(join(claude,'settings.json'),'utf8'),'{not json');
 await assert.rejects(readdir(join(claude,'skills')),{code:'ENOENT'},'the mod is not placed without the user off');
});
