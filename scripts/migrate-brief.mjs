// One-time data conversion, never imported by the runtime. Stop the Web first.
import {cp,readFile,readdir,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from '../lib/data-directory.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {markdownText} from '../lib/markdown.mjs';

export async function migrateBrief(directory) {
 const workspace=join(directory,'workspace'),schema=await readJson(join(workspace,'schema.json'));
 if(schema?.format!=='goal-workspace'||schema.version!==5)throw new Error('This one-time conversion requires workspace schema 5.');
 const goals=(await readdir(join(workspace,'goals'))).filter(n=>/^[1-9][0-9]*$/.test(n));
 const eventFiles=(await readdir(join(workspace,'events'))).filter(n=>/^[1-9][0-9]*\.json$/.test(n));
 const events=await Promise.all(eventFiles.map(file=>readJson(join(workspace,'events',file))));
 const changes=[];let annotations=0;
 // Validate every annotation before changing any source file.
 for(let i=0;i<events.length;i++) {
  const event=structuredClone(events[i]);let changed=false;
  for(const note of event.annotations||[]) {
   if(note.source?.kind==='overview'){note.source.kind='brief';changed=true;}
   if(note.kind!=='text'||note.source?.field==='title')continue;
   let source;
   if(note.source.kind==='comment') {
    const target=events.find(e=>e.id===note.source.eventId&&e.goalId===event.goalId);
    if(!target)throw new Error(`Missing annotation target in event ${event.id}.`);
    source=markdownText(target.text);note.anchor.quote=markdownText(note.anchor.quote).trim();
   } else if(note.source.kind==='brief') {
    const snapshot=await readJson(join(workspace,'goals',event.goalId,'overviews',`v${note.source.version}.json`));
    if(!snapshot)throw new Error(`Missing Brief snapshot in event ${event.id}.`);
    source=markdownText(snapshot.body);
   } else throw new Error(`Unknown annotation source in event ${event.id}.`);
   const quote=note.anchor.quote,start=source.indexOf(quote);
   if(!quote||start<0||source.indexOf(quote,start+1)>=0)throw new Error(`Cannot uniquely relocate annotation in event ${event.id}; workspace left unchanged.`);
   note.anchor={start,end:start+quote.length,quote};changed=true;annotations++;
  }
  if(changed)changes.push({file:eventFiles[i],event});
 }
 // Verify paths now, so an already converted or partial directory is not overwritten.
 for(const id of goals) {
  const entries=await readdir(join(workspace,'goals',id));
  if(!entries.includes('overview.md')||entries.includes('brief.md')||entries.includes('briefs'))throw new Error(`Unexpected source layout for Goal ${id}.`);
 }
 const backup=join(directory,'backups',`before-brief-v6-${new Date().toISOString().replace(/[:.]/g,'-')}`);
 await cp(workspace,backup,{recursive:true,errorOnExist:true,force:false});
 for(const id of goals) {
  const base=join(workspace,'goals',id);
  await rename(join(base,'overview.md'),join(base,'brief.md'));
  if((await readdir(base)).includes('overviews'))await rename(join(base,'overviews'),join(base,'briefs'));
 }
 for(const {file,event} of changes)await writeJsonAtomically(join(workspace,'events',file),event);
 await writeJsonAtomically(join(workspace,'schema.json'),{format:'goal-workspace',version:6});
 return {backup,goals:goals.length,annotations,schema:6};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await migrateBrief(dataDirectory())));
