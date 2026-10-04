// One-time data conversion. Runtime only reads schema 7.
import {cp,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {writeJsonAtomically} from '../lib/storage.mjs';
export async function migrateBriefFormats(directory) {
 const work=join(directory,'workspace'),schema=JSON.parse(await readFile(join(work,'schema.json'),'utf8'));
 if(schema.version!==6)throw new Error('Expected workspace schema 6.');
 const backup=join(directory,'backups',`before-brief-formats-v7-${new Date().toISOString().replace(/[:.]/g,'-')}`);
 await cp(work,backup,{recursive:true});let snapshots=0;
 for(const id of await readdir(join(work,'goals'))) {
  const folder=join(work,'goals',id,'briefs');let files=[];try{files=await readdir(folder);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const file of files.filter(n=>/^v\d+\.json$/.test(n))) {
   const path=join(folder,file),brief=JSON.parse(await readFile(path,'utf8'));
   await writeJsonAtomically(path,{...brief,format:'markdown'});snapshots++;
  }
 }
 await writeJsonAtomically(join(work,'schema.json'),{format:'goal-workspace',version:7});
 return {backup,snapshots};
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await migrateBriefFormats(process.env.CHILL_AGENT_DATA_DIR)));
