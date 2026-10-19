// Migration-only adapter: retire the old per-Root launchd service.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {dataDirectory,validId} from './extension-api.mjs';
const execute=promisify(execFile);
export async function monitorService(id,action){
 validId(id);if(process.platform!=='darwin')return {running:false};
 const directory=dataDirectory(),label=`com.chill-agent.monitor.${createHash('sha256').update(`${directory}:${id}`).digest('hex').slice(0,12)}`;
 const domain=`gui/${process.getuid()}`,target=`${domain}/${label}`;
 let existing='';try{existing=(await execute('/bin/launchctl',['print',target])).stdout;}catch(error){if(!/Could not find service/.test(error.stderr||''))throw error;}
 if(action==='stop'){if(existing)await execute('/bin/launchctl',['bootout',target]);return {running:false};}
 if(action==='status')return {running:/\bpid = \d+/.test(existing)};
 throw Error('Standalone monitor services are retired. Use the Web server extension.');
}
