#!/usr/bin/env node
// Development helper: run this checkout, including uncommitted changes, in one
// project's own Web without GitHub or CI. It packs the checkout and points only
// that project's data at the package; the Web's update button switches. --reset returns the
// project to its recorded version file. Nothing in the project is changed.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,mkdir,readdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {projectDirectory} from '../lib/project-workspace.mjs';
import {npmCommand,readVersionSource,recordVersionSource} from '../lib/version-source.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';

const usage=`Usage: npm run try-local -- --project <directory> [--reset] [--restart]

Packs this checkout (uncommitted changes included) and selects the package for
that project's Web. The Web then shows its update button; switching happens
when someone presses it, so nothing restarts in the middle of running work.
--reset returns the project to the version file its setup recorded.
--restart restarts the Web immediately instead; if it does not start, the previous
runtime is restored.`;
const keep=3;

export async function tryLocal({project,reset=false,restartWeb=false,repo=fileURLToPath(new URL('../',import.meta.url)),base,run=execFileSync,now=Date.now}) {
  const directory=await projectDirectory(resolve(project),...(base?[base]:[]));
  const local=join(directory,'runtime','local'),saved=join(local,'recorded-source.json');
  const source=await readVersionSource(directory);
  if(!source)throw Error('This project has no recorded version file. Run chill setup in the project first.');
  const recorded=await readJson(saved);
  // Node runs the launcher directly, so this also works where the shell launcher does not (Windows).
  const restart=()=>{if(!restartWeb)return null;const started=now();run(process.execPath,[join(directory,'runtime','chill.mjs'),'server','restart','--configured'],{stdio:'inherit'});return now()-started;};
  if(reset){
    if(!recorded)return {reset:false,note:'The project already uses its recorded version file.'};
    await recordVersionSource(directory,recorded);await rm(saved,{force:true});
    return {reset:true,versionFile:recorded.versionFile,restartMs:restart(),...(restartWeb?{}:{next:'Press the update button in the Web if it shows one.'})};
  }
  // Remember the setup's version file once, so a later --reset can return to it.
  await mkdir(local,{recursive:true});
  if(!recorded)await writeJsonAtomically(saved,{versionFile:source.versionFile,...(source.agentGuide?{agentGuide:source.agentGuide}:{})});
  const git=args=>run('git',args,{cwd:repo,encoding:'utf8'}).trim();
  const sha=git(['rev-parse','--short','HEAD']),dirty=git(['status','--porcelain','--untracked-files=no'])!=='';
  const packStarted=now();
  const npm=npmCommand();
  const name=JSON.parse(run(npm.file,[...npm.args,'pack','--json','--pack-destination',local],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','inherit']}))[0].filename;
  const hash=createHash('sha256').update(await readFile(join(local,name))).digest('hex').slice(0,10);
  // A new file name per build gives a new package spec, so the Web installs it.
  const tarball=join(local,`chill-agent-cli-${sha}-${hash}.tgz`);await rename(join(local,name),tarball);
  const packMs=now()-packStarted,versionFile=join(local,'chill-agent.json'),spec=`file:${tarball}`;
  // What a failed restart returns to: the selected file, its source and the installed runtime.
  const installation=join(directory,'runtime','installation.json');
  const before={versionFile:await readFile(versionFile,'utf8').catch(()=>null),installation:await readJson(installation)};
  await writeJsonAtomically(versionFile,{package:spec});
  await recordVersionSource(directory,{versionFile,...(source.agentGuide?{agentGuide:source.agentGuide}:{})});
  let restartMs;
  try{restartMs=restart();}
  catch(error){
    // Like the Web's update button: a package whose Web cannot start is not left selected.
    if(before.versionFile===null)await rm(versionFile,{force:true});else await writeFile(versionFile,before.versionFile);
    await recordVersionSource(directory,source);
    if(before.installation)await writeJsonAtomically(installation,before.installation);
    run(process.execPath,[join(directory,'runtime','chill.mjs'),'server','restart','--configured'],{stdio:'inherit',env:{...process.env,CHILL_AGENT_VERSION_SWITCHED:'1'}});
    throw Error(`The new package's Web did not start, so the previous runtime was restored. ${error.message}`);
  }
  // Keep the newest packages; the Web runs from its own installed copy.
  const old=await Promise.all((await readdir(local)).filter(f=>f.endsWith('.tgz')&&join(local,f)!==tarball).map(async f=>({f,at:(await stat(join(local,f))).mtimeMs})));
  for(const {f} of old.sort((a,b)=>b.at-a.at).slice(keep-1))await rm(join(local,f),{force:true});
  const result={package:spec,commit:sha,uncommitted:dirty,packMs,restartMs,...(restartWeb?{}:{next:'Press the update button in the Web to switch to this package.'})};
  await appendFile(join(local,'timings.jsonl'),JSON.stringify({at:new Date(now()).toISOString(),...result})+'\n');
  return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{project:{type:'string'},reset:{type:'boolean'},restart:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  if(values.help||!values.project){console.log(usage);process.exitCode=values.help?0:1;}
  else tryLocal({project:values.project,reset:values.reset,restartWeb:values.restart}).then(r=>console.log(JSON.stringify(r,null,2)),e=>{console.error(e.message);process.exitCode=1;});
}
