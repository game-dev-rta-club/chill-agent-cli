import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rm,mkdtemp,rename,writeFile} from 'node:fs/promises';
import {basename,delimiter,dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {readJson,writeJsonAtomically} from './storage.mjs';

const run=promisify(execFile);

// A version file is the application's `cli.json`: {"package": "<npm package spec>"}.
// The CLI never interprets the spec; npm resolves it, including any build step.
export async function readPackageSpec(versionFile) {
  if(typeof versionFile!=='string'||!isAbsolute(versionFile))throw Error('The version file path must be absolute.');
  const value=JSON.parse(await readFile(versionFile,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join()!=='package'||typeof value.package!=='string'||!value.package.trim()||/[\r\n\0]/.test(value.package))
    throw Error('The version file must contain only {"package": "<npm package spec>"}.');
  return value.package.trim();
}
export const packageKey=spec=>createHash('sha1').update(spec).digest('hex');

// Setup records where the application keeps its version file and agent guide.
// The CLI does not know the application's layout; it only reads these paths.
const sourcePath=directory=>join(directory,'runtime','version-source.json');
export async function recordVersionSource(directory,{versionFile,agentGuide}) {
  const source={version:1,versionFile:await realpath(versionFile)};
  if(agentGuide!==undefined){
    if(!(await realpath(agentGuide)).endsWith('.md'))throw Error('The agent guide must be a Markdown file.');
    source.agentGuide=await realpath(agentGuide);
  }
  await writeJsonAtomically(sourcePath(directory),source);
  return source;
}
export async function readVersionSource(directory) {
  const source=await readJson(sourcePath(directory));
  return source?.version===1&&isAbsolute(source.versionFile||'')?source:null;
}

// Each prepared snapshot remembers the package it came from, so the running
// server can compare its own source with the version file.
const snapshotSource=(directory,id)=>join(directory,'runtime','packages',`${id}.source.json`);
export const recordSnapshotPackage=(directory,id,spec)=>writeJsonAtomically(snapshotSource(directory,id),{package:spec});
export async function snapshotPackage(directory,root) {
  return (await readJson(snapshotSource(directory,basename(root))))?.package??null;
}

// Install the spec with npm into a fresh folder and return the package root.
// npm runs the package's prepare script for git and other unbuilt sources.
export async function acquirePackage(spec,directory,{execute=run,node=process.execPath}={}) {
  const parent=join(directory,'runtime','acquired');
  await mkdir(parent,{recursive:true});
  const target=join(parent,packageKey(spec)),stage=await mkdtemp(join(parent,'.install-'));
  try {
    const env={...process.env,PATH:[dirname(node),process.env.PATH].filter(Boolean).join(delimiter)};
    await writeFile(join(stage,'package.json'),JSON.stringify({private:true}));
    await execute('npm',['install','--no-audit','--no-fund','--no-package-lock','--prefix',stage,spec],{env,timeout:10*60*1000,maxBuffer:16*1024*1024});
    const installed=JSON.parse(await readFile(join(stage,'package.json'),'utf8')).dependencies||{};
    const names=Object.keys(installed);
    if(names.length!==1)throw Error('The package spec must install exactly one package.');
    await rm(target,{recursive:true,force:true});
    await rename(stage,target);
    return join(target,'node_modules',names[0]);
  } finally { await rm(stage,{recursive:true,force:true}); }
}

// When the recorded version file selects a package other than the one `root`
// was prepared from, acquire and prepare it. Returns the new installation, or
// null to keep the current one; failures are logged and keep the current one.
// The update worker's own restarts set CHILL_AGENT_VERSION_SWITCHED to skip this.
export async function prepareSelectedPackage(directory,root,{prepare,acquire=acquirePackage,log=()=>{}}) {
  const source=await readVersionSource(directory);
  if(!source)return null;
  let spec;
  try{spec=await readPackageSpec(source.versionFile);}
  catch(error){log(`Version file ignored: ${error.message}`);return null;}
  if(await snapshotPackage(directory,root)===spec)return null;
  try{return await prepare(await acquire(spec,directory),directory,{package:spec});}
  catch(error){log(`Could not switch to ${spec}: ${error.message}. Starting the current version.`);return null;}
}
