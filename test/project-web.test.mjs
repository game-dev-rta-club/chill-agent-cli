import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {prepareProject,projectProfile,selectProjectPort,workspacePort} from '../lib/project-workspace.mjs';
import {saveMessageSetting,readMessageSettings} from '../lib/message-settings.mjs';

test('two live project Web servers keep Goals and URLs separate and preserve a running endpoint',async t=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {once}=await import('node:events');
 const execute=promisify(execFile),base=await mkdtemp(join(tmpdir(),'chill-live-projects-'));
 const children=[];t.after(async()=>{for(const {child,exit} of children){child.kill('SIGTERM');await exit;}await rm(base,{recursive:true,force:true});});
 async function start(name){
  const project=join(base,name);await mkdir(project);const directory=await prepareProject(project,{base,extensions:[]});
  const env={...process.env,CHILL_AGENT_DATA_DIR:directory,CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname,CODEX_THREAD_ID:'00000000-0000-0000-0000-000000000001'};delete env.PORT;
  await execute(process.execPath,[new URL('../bin/chill-agent.mjs',import.meta.url).pathname,'create','--title',name],{env});
  const child=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--idle-timeout','1m'],{env,stdio:['ignore','pipe','pipe']});const exit=once(child,'exit');children.push({child,exit});
  const url=await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});child.stderr.on('data',c=>{output+=c;});child.once('error',reject);child.once('exit',()=>reject(Error(output)));});
  return {project,directory,url};
 }
 const a=await start('Alpha'),b=await start('Beta');assert.notEqual(a.url,b.url);
 const ga=await (await fetch(a.url+'/api/goals')).json(),gb=await (await fetch(b.url+'/api/goals')).json();
 assert.equal(ga.length,1);assert.equal(gb.length,1);assert.equal(ga[0].title,'Alpha');assert.equal(gb[0].title,'Beta');
 assert.equal(await prepareProject(a.project,{base}),a.directory);assert.equal(projectProfile(a.directory).port,Number(new URL(a.url).port));
 assert.equal((await fetch(a.url+'/api/workspace-instance')).status,404);
});
