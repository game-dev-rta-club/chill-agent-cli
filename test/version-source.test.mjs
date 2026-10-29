import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readPackageSpec,packageKey,readVersionSource,recordVersionSource,snapshotPackage,prepareSelectedPackage,acquirePackage,npmCommand} from '../lib/version-source.mjs';
import {createRuntimeUpdates} from '../lib/runtime-update-provider.mjs';
import {agentGuide} from '../lib/agent-guidance.mjs';

const execute=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));

async function fixture(t,spec='github:example/chill#aaaa'){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-version-'))),skill=join(dir,'skill'),project=join(dir,'project'),data=join(dir,'data');
 await mkdir(skill);await mkdir(project);
 const versionFile=join(skill,'chill-agent.json'),guide=join(skill,'SKILL.md');
 await writeFile(versionFile,JSON.stringify({package:spec}));await writeFile(guide,'# Guide\n');
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const env={...process.env,CHILL_AGENT_DATA_DIR:data,CHILL_AGENT_CODEX_PATH:'/never/call/codex'};
 delete env.CHILL_AGENT_HARNESS;delete env.CHILL_AGENT_SESSION_ID;delete env.CHILL_AGENT_CONNECTION_GENERATION;
 const setup=async(...extra)=>JSON.parse((await execute(process.execPath,[join(root,'bin/chill-setup.mjs'),'prepare','--harness','claude-code','--project',project,...extra],{env,timeout:30000,maxBuffer:4*1024*1024})).stdout);
 return {dir,skill,project,data,versionFile,guide,setup,spec};
}

test('a version file holds exactly one npm package spec',async t=>{
 const f=await fixture(t);
 assert.equal(await readPackageSpec(f.versionFile),f.spec);
 for(const value of [{},{package:''},{package:'x',other:1},['x'],{package:'a\nb'}]){
  await writeFile(f.versionFile,JSON.stringify(value));
  await assert.rejects(readPackageSpec(f.versionFile),/only \{"package"/);
 }
 await assert.rejects(readPackageSpec('relative/chill-agent.json'),/absolute/);
});

test('a project set up when the file was cli.json reads chill-agent.json once the skill holds only that',async t=>{
 const f=await fixture(t),old=join(f.skill,'cli.json');
 await rename(f.versionFile,old);await recordVersionSource(f.data,{versionFile:old});
 assert.equal((await readVersionSource(f.data)).versionFile,old,'the recorded file is read while it exists');
 await rename(old,f.versionFile);
 assert.equal((await readVersionSource(f.data)).versionFile,f.versionFile);
 await rm(f.versionFile);
 assert.equal((await readVersionSource(f.data)).versionFile,old,'with neither file, the record is unchanged and the Web keeps its version');
});

test('setup records the version file, its package and the agent guide, then names the session command',async t=>{
 const f=await fixture(t);
 const result=await f.setup('--version-file',f.versionFile,'--agent-guide',f.guide);
 assert.equal(result.package,f.spec);
 assert.match(result.next,/session start --harness claude-code --project/);
 assert.deepEqual(await readVersionSource(f.data),{version:1,versionFile:f.versionFile,agentGuide:f.guide});
 assert.equal(await snapshotPackage(f.data,result.root),f.spec);
 assert.equal(agentGuide(pathToFileURL(resolve('/nonexistent/extensions.json'))),f.guide,'a runtime without its own guide uses the recorded one');
 // Setup without the option, as session start runs it, keeps the snapshot's package record.
 const again=await f.setup();
 assert.equal(again.root,result.root);assert.equal(again.package,f.spec);assert.doesNotMatch(again.next,/session start/);
 await assert.rejects(f.setup('--agent-guide',f.guide),/requires --version-file/);
});

test('the update provider compares the running snapshot with the version file',async t=>{
 const f=await fixture(t);
 const result=await f.setup('--version-file',f.versionFile);
 const acquired=[];
 const provider=createRuntimeUpdates({runtime:result.root,acquire:async(spec)=>{acquired.push(spec);return '/acquired';}});
 assert.equal(await provider.current(f.data),packageKey(f.spec));
 assert.deepEqual(await provider.candidate(f.data),{key:packageKey(f.spec)});
 const next='github:example/chill#bbbb';
 await writeFile(f.versionFile,JSON.stringify({package:next}));
 const candidate=await provider.candidate(f.data);
 assert.equal(candidate.key,packageKey(next));assert.notEqual(candidate.key,await provider.current(f.data));
 assert.equal(await provider.package(f.data,candidate.key),next);
 assert.equal(await provider.package(f.data,packageKey(f.spec)),null,'a stale key names no package');
 assert.equal(await provider.acquire(f.data,candidate.key),'/acquired');assert.deepEqual(acquired,[next]);
 await assert.rejects(provider.acquire(f.data,packageKey(f.spec)),/changed/);
});

test('Web startup switches only when the version file selects another package',async t=>{
 const f=await fixture(t);
 const result=await f.setup('--version-file',f.versionFile);
 const calls=[],logs=[];
 const options={prepare:async(target,directory,extra)=>{calls.push({target,directory,extra});return {root:'/new'};},acquire:async spec=>`/acquired/${spec}`,log:m=>logs.push(m)};
 assert.equal(await prepareSelectedPackage(f.data,result.root,options),null,'the same package keeps the current runtime');
 await writeFile(f.versionFile,JSON.stringify({package:'github:example/chill#cccc'}));
 assert.deepEqual(await prepareSelectedPackage(f.data,result.root,options),{root:'/new'});
 assert.deepEqual(calls,[{target:'/acquired/github:example/chill#cccc',directory:f.data,extra:{package:'github:example/chill#cccc'}}]);
 assert.equal(await prepareSelectedPackage(f.data,result.root,{...options,acquire:async()=>{throw Error('offline');}}),null);
 assert.match(logs.at(-1),/offline\. Starting the current version/);
 await writeFile(f.versionFile,'{"package":');
 assert.equal(await prepareSelectedPackage(f.data,result.root,options),null);assert.match(logs.at(-1),/Version file ignored/);
});

test('npm acquires the package spec into the data directory',async t=>{
 const f=await fixture(t),pkg=join(f.dir,'pkg');
 await mkdir(pkg);await writeFile(join(pkg,'package.json'),JSON.stringify({name:'fake-chill-cli',version:'1.0.0'}));await writeFile(join(pkg,'index.js'),'');
 const npm=npmCommand();
 const tarball=join(f.dir,(await execute(npm.file,[...npm.args,'pack','--pack-destination',f.dir],{cwd:pkg})).stdout.trim());
 const installed=await acquirePackage(`file:${tarball}`,f.data);
 assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).name,'fake-chill-cli');
 assert.ok(installed.startsWith(join(f.data,'runtime','acquired',packageKey(`file:${tarball}`))));
});

test('npm runs as the command on PATH, except through Node on Windows',()=>{
 assert.deepEqual(npmCommand('/opt/node/bin/node',{platform:'darwin'}),{file:'npm',args:[]});
 const node=join(tmpdir(),'node js','node.exe'),script=join(tmpdir(),'node js','node_modules','npm','bin','npm-cli.js'),other=join(tmpdir(),'npm','npm-cli.js');
 assert.deepEqual(npmCommand(node,{platform:'win32',env:{},exists:path=>path===script}),{file:node,args:[script]});
 assert.deepEqual(npmCommand(node,{platform:'win32',env:{npm_execpath:other},exists:path=>path===other}),{file:node,args:[other]});
 assert.throws(()=>npmCommand(node,{platform:'win32',env:{},exists:()=>false}),/npm was not found/);
});
