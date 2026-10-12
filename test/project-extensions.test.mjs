import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareProject,workspacePort} from '../lib/project-workspace.mjs';
import {registeredExtensions} from '../lib/extension-registry.mjs';
import {connectionExtensions} from '../lib/connection-extensions.mjs';
import {notificationProvider} from '../lib/notification-provider.mjs';

test('project selection restricts Web, native hooks and notification routes independently',async t=>{
 const base=await mkdtemp(join(tmpdir(),'chill-project-extensions-'));
 const previous=process.env.CHILL_AGENT_DATA_DIR;
 t.after(async()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;await rm(base,{recursive:true,force:true});});
 const a=join(base,'a'),b=join(base,'b');await mkdir(a);await mkdir(b);
 process.env.CHILL_AGENT_DATA_DIR=await prepareProject(a,{base,extensions:[]});
 assert.deepEqual(registeredExtensions(),[]);assert.deepEqual(await connectionExtensions(),{});
 assert.equal((await (await notificationProvider()).prepare('1',1)).enabled,false);
 process.env.CHILL_AGENT_DATA_DIR=await prepareProject(b,{base,extensions:['public-link']});
 assert.deepEqual(registeredExtensions({tunnel:{}}).map(x=>x.id),['public-link']);
 assert.deepEqual(await connectionExtensions(),{});
 await prepareProject(b,{base,extensions:['web-notifications']});
 assert.deepEqual(registeredExtensions().map(x=>x.id),['web-notifications']);
 await assert.rejects(async()=> (await notificationProvider()).configure('1',{}),/disabled for this project/);
});

test('Auto mode messages use the isolated project port without a PORT override',async t=>{
 const {continuationMessage}=await import('../lib/continuation-monitor.mjs');
 const base=await mkdtemp(join(tmpdir(),'chill-project-message-')),oldDir=process.env.CHILL_AGENT_DATA_DIR,oldPort=process.env.PORT;
 t.after(async()=>{if(oldDir===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=oldDir;if(oldPort===undefined)delete process.env.PORT;else process.env.PORT=oldPort;await rm(base,{recursive:true,force:true});});
 const project=join(base,'project');await mkdir(project);process.env.CHILL_AGENT_DATA_DIR=await prepareProject(project,{base});delete process.env.PORT;
 const expected=workspacePort();assert.match(continuationMessage({rootId:'1'},1,'attempt'),new RegExp("PORT='"+expected+"'"));
 process.env.PORT='43199';assert.match(continuationMessage({rootId:'1'},1,'attempt'),/PORT='43199'/);
});

test('monitor start contacts the project Web without an explicit PORT',async t=>{
 const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const base=await mkdtemp(join(tmpdir(),'chill-monitor-port-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const project=join(base,'project');await mkdir(project);const directory=await prepareProject(project,{base});let requested=null;
 const token='project-instance-test';
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/workspace-instance'){res.end(JSON.stringify({token:req.headers['x-chill-instance']===token?token:null}));return;}requested=req.url;res.end('[]');});
 await new Promise(resolve=>server.listen(workspacePort({CHILL_AGENT_DATA_DIR:directory}),'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const {writeJsonAtomically}=await import('../lib/storage.mjs');await writeJsonAtomically(join(directory,'runtime','endpoint.json'),{port:server.address().port,token});
 const env={...process.env,CHILL_AGENT_DATA_DIR:directory};delete env.PORT;delete env.CLAUDE_SESSION_ID;delete env.CHILL_AGENT_CLAUDE_SESSION_ID;delete env.CHILL_AGENT_CLAUDE_GENERATION;
 await assert.rejects(promisify(execFile)(process.execPath,[new URL('../bin/chill-monitor.mjs',import.meta.url).pathname,'start','--id','1'],{env}),e=>e.stderr.includes('does not host the continuation extension'));
 assert.equal(requested,'/api/goals/1/extensions');
});
