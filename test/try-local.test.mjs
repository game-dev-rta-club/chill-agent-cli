import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tryLocal} from '../scripts/try-local.mjs';
import {readVersionSource,recordVersionSource} from '../lib/version-source.mjs';
import {projectDirectory} from '../lib/project-workspace.mjs';

test('try-local points only the project data at a packed checkout and --reset restores the recorded version file',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-try-local-')));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const project=join(dir,'project'),base=join(dir,'base'),versionFile=join(project,'chill-agent.json');
 await mkdir(project,{recursive:true});await writeFile(versionFile,JSON.stringify({package:'github:org/cli#abc'}));
 await assert.rejects(tryLocal({project,base,run:()=>''}),/no recorded version file/);
 const directory=await projectDirectory(project,base);await recordVersionSource(directory,{versionFile});
 let content='one';const restarts=[];
 const run=(file,args)=>{
  if(file==='git')return args[0]==='rev-parse'?'1234567\n':' M lib/x.mjs\n';
  if(args.includes('pack')){writeFileSync(join(args[args.indexOf('--pack-destination')+1],'cli-0.0.0.tgz'),content);return JSON.stringify([{filename:'cli-0.0.0.tgz'}]);}
  restarts.push([file,...args].join(' '));return '';
 };
 const first=await tryLocal({project,base,run});
 assert.equal(restarts.length,0,'the Web switches only when its update button is pressed');assert.equal(first.restartMs,null);
 await tryLocal({project,base,run,restartWeb:true});
 assert.match(first.package,/^file:.*runtime[\\/]local[\\/]chill-agent-cli-1234567-[0-9a-f]{10}\.tgz$/);assert.equal(first.uncommitted,true);
 const source=await readVersionSource(directory);
 assert.equal(source.versionFile,join(directory,'runtime','local','chill-agent.json'));
 assert.deepEqual(JSON.parse(await readFile(source.versionFile,'utf8')),{package:first.package});
 assert.deepEqual(JSON.parse(await readFile(versionFile,'utf8')),{package:'github:org/cli#abc'},'the project file is unchanged');
 assert.equal(restarts.length,1);assert.match(restarts[0],/runtime[\\/]chill\.mjs server restart --configured$/);
 // Identical content gives the same package; changed content a new one.
 assert.equal((await tryLocal({project,base,run})).package,first.package);
 for(const c of ['two','three','four']){content=c;await tryLocal({project,base,run});}
 assert.equal(restarts.length,1,'only --restart restarts');
 assert.equal((await readdir(join(directory,'runtime','local'))).filter(f=>f.endsWith('.tgz')).length,3,'only the newest packages are kept');
 assert.equal((await readFile(join(directory,'runtime','local','timings.jsonl'),'utf8')).trim().split('\n').length,6);
 const reset=await tryLocal({project,base,run,reset:true});
 assert.equal(reset.reset,true);assert.equal((await readVersionSource(directory)).versionFile,versionFile);
 assert.equal((await tryLocal({project,base,run,reset:true})).reset,false,'a second reset has nothing to restore');
});

test('try-local --restart restores the previous runtime when the new Web does not start',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-try-local-'))); t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const project=join(dir,'project'),base=join(dir,'base'),versionFile=join(project,'chill-agent.json');
 await mkdir(project,{recursive:true});await writeFile(versionFile,JSON.stringify({package:'github:org/cli#abc'}));
 const directory=await projectDirectory(project,base);await recordVersionSource(directory,{versionFile});
 const installed={root:join(directory,'runtime','packages','old'),id:'old'};
 await mkdir(join(directory,'runtime'),{recursive:true});await writeFile(join(directory,'runtime','installation.json'),JSON.stringify(installed));
 const restarts=[];
 const run=(file,args,options={})=>{
  if(file==='git')return args[0]==='rev-parse'?'1234567\n':'';
  if(args.includes('pack')){writeFileSync(join(args[args.indexOf('--pack-destination')+1],'cli-0.0.0.tgz'),'broken');return JSON.stringify([{filename:'cli-0.0.0.tgz'}]);}
  restarts.push(options.env?.CHILL_AGENT_VERSION_SWITCHED||'switch');
  // The new package's Web fails and leaves its broken install selected.
  if(restarts.length===1){writeFileSync(join(directory,'runtime','installation.json'),JSON.stringify({root:'broken',id:'broken'}));throw Error('Server did not stay running.');}
  return '';
 };
 await assert.rejects(tryLocal({project,base,run,restartWeb:true}),/previous runtime was restored.*did not stay running/);
 assert.deepEqual(restarts,['switch','1'],'the previous runtime restarts without switching again');
 assert.equal((await readVersionSource(directory)).versionFile,versionFile,'the previous version file is selected again');
 assert.deepEqual(JSON.parse(await readFile(join(directory,'runtime','installation.json'),'utf8')),installed);
});
