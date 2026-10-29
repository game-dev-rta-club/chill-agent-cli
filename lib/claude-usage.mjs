// Claude plan usage, as the usage mod (claude-mods/chill-agent-usage) records
// it from the last Claude Code response: one file for the account, in the
// Claude folder. Claude Code updates it only while a conversation runs.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {claudeDirectory} from './claude-setup.mjs';

const minutes={five_hour:300,seven_day:10080};
export const claudeUsagePath=(claude=claudeDirectory())=>join(claude,'chill-agent-usage','usage.json');

// The Agent menu's usage buckets, or null when nothing was recorded.
export async function readClaudeUsage({path=claudeUsagePath(),now=Date.now()}={}) {
  let data;
  try {data=JSON.parse(await readFile(path,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
  // A window past its reset no longer says how much of the new one is used.
  const windows=(Array.isArray(data?.rateLimits)?data.rateLimits:[]).flatMap(w=>{
    const resetAt=Date.parse(w?.resetsAt);
    if(!Object.hasOwn(minutes,w?.kind)||typeof w.percentUsed!=='number'||!(resetAt>now))return [];
    return [{id:w.kind,remaining:Math.max(0,100-w.percentUsed),minutes:minutes[w.kind],resetAt:Math.floor(resetAt/1000)}];
  });
  return windows.length?{usage:[{id:'claude',name:'Claude',windows}],at:typeof data.at==='string'?data.at:null}:null;
}
