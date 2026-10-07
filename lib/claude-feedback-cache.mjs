import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {dataDirectory,readFeedback} from './goal-store.mjs';

// A cache owned by one watcher, not shared by conversations or processes.
// Event writes are atomic renames/links: a directory metadata change invalidates
// the snapshot. Capture the stamp before reading so a concurrent write is
// checked again on the next poll. Delivery, ownership and holds remain live.
export function createClaudeFeedbackReader({directory=dataDirectory(),read=readFeedback}={}) {
  let stamp,snapshot;
  return async()=>{
    let next;
    try {
      const s=await stat(join(directory,'workspace/events'),{bigint:true});
      next=[s.dev,s.ino,s.mtimeNs,s.ctimeNs].join(':');
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      next='missing';
    }
    if(snapshot===undefined||next!==stamp){snapshot=await read();stamp=next;}
    return snapshot;
  };
}
