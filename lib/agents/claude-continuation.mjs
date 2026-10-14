// AutoContinue for a Claude conversation: it continues at its own Stop hook,
// so nothing polls it and its status does not go stale between Stops. A run's
// output is the response that followed the request in its transcript.
import {readForWeb,configureFromWeb} from '../claude-continuation.mjs';
import {claudeEntryPaths} from '../claude-entry.mjs';
import {claudeWork} from '../claude-transcript.mjs';
import {dataDirectory} from '../data-directory.mjs';
import {readJson} from '../storage.mjs';

export function claudeContinuation(root,{read=readForWeb,configure=configureFromWeb,transcript=async()=>(await readJson(claudeEntryPaths(dataDirectory(),root.connection.sessionId).record).catch(()=>null))?.transcriptPath,work=claudeWork}={}) {
  return {
    live:false,
    read:()=>read(root.id),
    configure:enabled=>configure(root.id,enabled),
    async runOutput(attempt){
      try{const path=await transcript();return {work:path?await work(path,attempt.id):null,error:null};}
      catch{return {work:null,error:'Updates unavailable. Saved output is kept.'};}
    },
  };
}
