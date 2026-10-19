import {fileURLToPath} from 'node:url';
import {dataDirectory} from './data-directory.mjs';
import {acquirePackage,packageKey,readPackageSpec,readVersionSource,snapshotPackage} from './version-source.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));

// The Web update button compares the package this server was prepared from
// with the version file recorded at setup. Keys are hashes of the npm spec;
// browser input never supplies a spec, path or command.
export function createRuntimeUpdates({runtime=root,acquire=acquirePackage}={}){
 async function selected(directory){
  const source=await readVersionSource(directory);
  if(!source)return null;
  try{return await readPackageSpec(source.versionFile);}catch{return null;}
 }
 return {
  current:async(directory=dataDirectory())=>{const spec=await snapshotPackage(directory,runtime);return spec?packageKey(spec):null;},
  candidate:async directory=>{const spec=await selected(directory);return spec?{key:packageKey(spec)}:null;},
  package:async(directory,key)=>{const spec=await selected(directory);return spec&&packageKey(spec)===key?spec:null;},
  acquire:async(directory,key)=>{
   const spec=await selected(directory);
   if(!spec||packageKey(spec)!==key)throw Error('The version file changed before acquisition.');
   return acquire(spec,directory);
  }
 };
}
