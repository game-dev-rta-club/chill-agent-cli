#!/usr/bin/env node
// Development helper: point another project's version file at this checkout's
// pushed commit, so its team runs the commit without a release.
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {projectDirectory} from '../lib/project-workspace.mjs';
import {readPackageSpec,readVersionSource} from '../lib/version-source.mjs';

const usage=`Usage: npm run use-in -- --project <directory> [--version-file <chill-agent.json>]

Writes {"package": "<this checkout's pushed commit>"} to the version file that the
project's setup recorded. Pass --version-file the first time, before the project
has run setup with one. The commit must already be on the remote.`;

export function packageForCommit(remote,sha) {
  const github=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  return github?`github:${github[1]}#${sha}`:`git+${remote}#${sha}`;
}

export async function useIn({project,versionFile,repo=fileURLToPath(new URL('../',import.meta.url)),base}) {
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
  git(['fetch','--quiet','origin']);
  const sha=git(['rev-parse','HEAD']);
  if(!git(['branch','-r','--contains',sha]))throw Error(`Commit ${sha.slice(0,7)} is not on the remote yet. Push it first so the project's team can install it.`);
  const target=versionFile?resolve(versionFile):(await readVersionSource(await projectDirectory(resolve(project),...(base?[base]:[]))))?.versionFile;
  if(!target)throw Error('This project has not recorded a version file. Pass --version-file the first time.');
  const from=await readPackageSpec(target).catch(()=>null),to=packageForCommit(git(['remote','get-url','origin']),sha);
  await writeFile(target,JSON.stringify({package:to},null,2)+'\n');
  return {versionFile:target,from,to,
    uncommitted:git(['status','--porcelain','--untracked-files=no'])!=='',
    next:'Commit the version file in that project. Starting its Web, or pressing the update button in an open Web, switches to this commit.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{project:{type:'string'},'version-file':{type:'string'},help:{type:'boolean',short:'h'}}});
  if(values.help||!values.project){console.log(usage);process.exitCode=values.help?0:1;}
  else useIn({project:values.project,versionFile:values['version-file']}).then(r=>{
    console.log(JSON.stringify(r,null,2));
    if(r.uncommitted)console.error('Note: uncommitted changes in this checkout are not part of the selected commit.');
  },e=>{console.error(e.message);process.exitCode=1;});
}
