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
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-try-local-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const project=join(dir,'project'),base=join(dir,'base'),versionFile=join(project,'cli.json'),guide=join(project,'SKILL.md');
 await mkdir(project,{recursive:true});await writeFile(versionFile,JSON.stringify({package:'github:org/cli#abc'}));await writeFile(guide,'# Guide');
 await assert.rejects(tryLocal({project,base,run:()=>''}),/no recorded version file/);
 const directory=await projectDirectory(project,base);await recordVersionSource(directory,{versionFile,agentGuide:guide});
 let content='one';const restarts=[];
 const run=(file,args)=>{
  if(file==='git')return args[0]==='rev-parse'?'1234567\n':' M lib/x.mjs\n';
  if(args.includes('pack')){writeFileSync(join(args[args.indexOf('--pack-destination')+1],'cli-0.0.0.tgz'),content);return JSON.stringify([{filename:'cli-0.0.0.tgz'}]);}
  restarts.push([file,...args].join(' '));return '';
 };
 const first=await tryLocal({project,base,run});
 assert.match(first.package,/^file:.*runtime[\\/]local[\\/]chill-agent-cli-1234567-[0-9a-f]{10}\.tgz$/);assert.equal(first.uncommitted,true);
 const source=await readVersionSource(directory);
 assert.equal(source.versionFile,join(directory,'runtime','local','cli.json'));assert.equal(source.agentGuide,guide,'the agent guide is kept');
 assert.deepEqual(JSON.parse(await readFile(source.versionFile,'utf8')),{package:first.package});
 assert.deepEqual(JSON.parse(await readFile(versionFile,'utf8')),{package:'github:org/cli#abc'},'the project file is unchanged');
 assert.equal(restarts.length,1);assert.match(restarts[0],/runtime[\\/]chill\.mjs server restart --configured$/);
 // Identical content gives the same package; changed content a new one.
 assert.equal((await tryLocal({project,base,run})).package,first.package);
 for(const c of ['two','three','four']){content=c;await tryLocal({project,base,run});}
 assert.equal((await readdir(join(directory,'runtime','local'))).filter(f=>f.endsWith('.tgz')).length,3,'only the newest packages are kept');
 assert.equal((await readFile(join(directory,'runtime','local','timings.jsonl'),'utf8')).trim().split('\n').length,5);
 const reset=await tryLocal({project,base,run,reset:true});
 assert.equal(reset.reset,true);assert.equal((await readVersionSource(directory)).versionFile,versionFile);assert.equal((await readVersionSource(directory)).agentGuide,guide);
 assert.equal((await tryLocal({project,base,run,reset:true})).reset,false,'a second reset has nothing to restore');
});
