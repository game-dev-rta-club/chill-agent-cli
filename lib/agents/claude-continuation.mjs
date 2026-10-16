// AutoContinue for a Claude conversation: it continues at its own Stop hook,
// so nothing polls it and its status does not go stale between Stops. A run's
// output is the response that followed the request in its transcript.
import {readForWeb,configureFromWeb} from '../claude-continuation.mjs';
import {claudeEntryPaths} from '../claude-entry.mjs';
import {claudeWork} from '../claude-transcript.mjs';
import {dataDirectory} from '../data-directory.mjs';
import {readJson} from '../storage.mjs';
import {runClaudeAction} from '../claude-actions.mjs';

export function claudeContinuation(root,{read=readForWeb,configure=configureFromWeb,transcript=async()=>(await readJson(claudeEntryPaths(dataDirectory(),root.connection.sessionId).record).catch(()=>null))?.transcriptPath,work=claudeWork}={}) {
  return {
    live:false,
    read:()=>read(root.id),
    configure:enabled=>configure(root.id,enabled),
    // chill monitor commands from the conversation run at once; nothing polls a
    // conversation that continues itself.
    async confirmed(command,input,{env=process.env}={}) {
      const [operation,payload]=command==='result'?['result',input]:['enable','disable'].includes(command)?['configure',{rootId:input.rootId,enabled:command==='enable'}]:
        ['pause','resume'].includes(command)?['pause',{rootId:input.rootId,paused:command==='pause'}]:[];
      if(!operation)throw Error('This agent uses monitor enable/disable and continues at its own Stop; start/tick/watch are not supported. pause/resume hold only future automatic continuations, not the running response.');
      return {text:(await runClaudeAction('extension',{extension:'continuation',operation,input:payload},{env})).text};
    },
    async runOutput(attempt){
      try{const path=await transcript();return {work:path?await work(path,attempt.id):null,error:null};}
      catch{return {work:null,error:'Updates unavailable. Saved output is kept.'};}
    },
  };
}
