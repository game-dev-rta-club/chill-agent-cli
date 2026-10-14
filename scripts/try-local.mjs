#!/usr/bin/env node
// Development helper: run this checkout, including uncommitted changes, in one
// project's own Web without GitHub or CI. It packs the checkout, points only
// that project's data at the package, and restarts its Web. --reset returns the
// project to its recorded version file. Nothing in the project is changed.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,mkdir,readdir,readFile,rename,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {projectDirectory} from '../lib/project-workspace.mjs';
import {readVersionSource,recordVersionSource} from '../lib/version-source.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';

const usage=`Usage: npm run try-local -- --project <directory> [--reset]

Packs this checkout (uncommitted changes included), makes that project's Web
run the package, and restarts the Web. --reset returns the project to the
version file its setup recorded and restarts the Web.`;
const keep=3;

export async function tryLocal({project,reset=false,repo=fileURLToPath(new URL('../',import.meta.url)),base,run=execFileSync,now=Date.now}) {
  const directory=await projectDirectory(resolve(project),...(base?[base]:[]));
  const local=join(directory,'runtime','local'),saved=join(local,'recorded-source.json');
  const source=await readVersionSource(directory);
  if(!source)throw Error('This project has no recorded version file. Run chill setup in the project first.');
  const recorded=await readJson(saved);
  const restart=()=>{const started=now();run(join(directory,'runtime','chill'),['server','restart','--configured'],{stdio:'inherit'});return now()-started;};
  if(reset){
    if(!recorded)return {reset:false,note:'The project already uses its recorded version file.'};
    await recordVersionSource(directory,recorded);await rm(saved,{force:true});
    return {reset:true,versionFile:recorded.versionFile,restartMs:restart()};
  }
  // Remember the setup's version file once, so a later --reset can return to it.
  await mkdir(local,{recursive:true});
  if(!recorded)await writeJsonAtomically(saved,{versionFile:source.versionFile,...(source.agentGuide?{agentGuide:source.agentGuide}:{})});
  const git=args=>run('git',args,{cwd:repo,encoding:'utf8'}).trim();
  const sha=git(['rev-parse','--short','HEAD']),dirty=git(['status','--porcelain','--untracked-files=no'])!=='';
  const packStarted=now();
  const name=JSON.parse(run('npm',['pack','--json','--pack-destination',local],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','inherit']}))[0].filename;
  const hash=createHash('sha256').update(await readFile(join(local,name))).digest('hex').slice(0,10);
  // A new file name per build gives a new package spec, so the Web installs it.
  const tarball=join(local,`chill-agent-cli-${sha}-${hash}.tgz`);await rename(join(local,name),tarball);
  const packMs=now()-packStarted,versionFile=join(local,'cli.json'),spec=`file:${tarball}`;
  await writeJsonAtomically(versionFile,{package:spec});
  await recordVersionSource(directory,{versionFile,...(source.agentGuide?{agentGuide:source.agentGuide}:{})});
  const restartMs=restart();
  // Keep the newest packages; the Web runs from its own installed copy.
  const old=await Promise.all((await readdir(local)).filter(f=>f.endsWith('.tgz')&&join(local,f)!==tarball).map(async f=>({f,at:(await stat(join(local,f))).mtimeMs})));
  for(const {f} of old.sort((a,b)=>b.at-a.at).slice(keep-1))await rm(join(local,f),{force:true});
  const result={package:spec,commit:sha,uncommitted:dirty,packMs,restartMs};
  await appendFile(join(local,'timings.jsonl'),JSON.stringify({at:new Date(now()).toISOString(),...result})+'\n');
  return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{project:{type:'string'},reset:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  if(values.help||!values.project){console.log(usage);process.exitCode=values.help?0:1;}
  else tryLocal({project:values.project,reset:values.reset}).then(r=>console.log(JSON.stringify(r,null,2)),e=>{console.error(e.message);process.exitCode=1;});
}
