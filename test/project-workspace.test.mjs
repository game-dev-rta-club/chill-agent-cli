import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {prepareProject,projectProfile,selectProjectPort,workspacePort,resolveWorkspacePort} from '../lib/project-workspace.mjs';
import {saveMessageSetting,readMessageSettings} from '../lib/message-settings.mjs';

test('project identity isolates stores, settings and extension choices; aliases reuse identity',async t=>{
 const base=await mkdtemp(join(tmpdir(),'chill-projects-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const a=join(base,'a'),b=join(base,'b');await mkdir(a);await mkdir(b);
 const da=await prepareProject(a,{base,extensions:[]}),db=await prepareProject(b,{base,extensions:['public-link']});
 assert.notEqual(da,db);assert.deepEqual(projectProfile(da).extensions,[]);assert.deepEqual(projectProfile(db).extensions,['public-link']);
 await saveMessageSetting('remote',{mode:'quick'},da);assert.equal((await readMessageSettings(db)).remote.mode,'off');
 await symlink(a,join(base,'alias'));assert.equal(await prepareProject(join(base,'alias'),{base}),da);
 assert.deepEqual(projectProfile(da).extensions,[]);
 assert.equal(workspacePort({CHILL_AGENT_DATA_DIR:da}),projectProfile(da).port);
});
test('occupied automatic port is replaced without taking over another server',async t=>{
 const base=await mkdtemp(join(tmpdir(),'chill-ports-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const project=join(base,'project');await mkdir(project);const data=await prepareProject(project,{base});
 const port=projectProfile(data).port,other=createServer();await new Promise(r=>other.listen(port,'127.0.0.1',r));t.after(()=>other.close());
 const replacement=await resolveWorkspacePort({CHILL_AGENT_DATA_DIR:data});assert.notEqual(replacement,port);assert.equal(other.listening,true);
 assert.equal(workspacePort({CHILL_AGENT_DATA_DIR:data}),replacement);
});


test('stale instance records never adopt a foreign Web; explicit ports remain caller choices',async t=>{
 const {createServer: httpServer}=await import('node:http');const {writeJsonAtomically}=await import('../lib/storage.mjs');
 const base=await mkdtemp(join(tmpdir(),'chill-foreign-web-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const project=join(base,'project');await mkdir(project);const data=await prepareProject(project,{base}),port=projectProfile(data).port;
 let requests=0;const other=httpServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({token:'different-instance'}));});
 await new Promise(resolve=>other.listen(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>other.close(resolve)));
 await writeJsonAtomically(join(data,'runtime','endpoint.json'),{pid:process.pid,port,token:'old-instance'});
 const next=await resolveWorkspacePort({CHILL_AGENT_DATA_DIR:data});assert.notEqual(next,port);assert.equal(requests,1);assert.equal(other.listening,true);
 assert.equal(await resolveWorkspacePort({CHILL_AGENT_DATA_DIR:data,PORT:String(port)}),port);
 assert.equal(projectProfile(data).port,next,'an explicit override does not rewrite the project');
});
