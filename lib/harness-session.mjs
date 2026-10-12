import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {harnessAdapter,harnessGuidance} from '../extensions/harnesses/index.mjs';
const run=promisify(execFile);
export async function startSession({project,harness},{execute=run,runtime=fileURLToPath(new URL('../',import.meta.url)),env=process.env,node=process.execPath}={}){
 const adapter=harnessAdapter(harness);
 if(!project)throw Error('Specify --project <native project directory>.');
 const cwd=await realpath(project),isolated={...env};delete isolated.CHILL_AGENT_DATA_DIR;delete isolated.PORT;
 const setupFile=join(runtime,'bin/chill-setup.mjs'),selection=['--isolated','--project',cwd,'--harness',adapter.id];
 const options={cwd,env:isolated,maxBuffer:4*1024*1024};
 const extra=await adapter.setupOptions({execute,node,setupFile,selection,options});
 const setup=JSON.parse((await execute(node,[setupFile,'prepare',...selection,...extra],options)).stdout);
 const serverOptions={...options,env:{...isolated,CHILL_AGENT_DATA_DIR:setup.dataDirectory}};
 const status=await execute(node,[setup.launcher,'server','status'],serverOptions);
 const server=/^Running \(PID /m.test(status.stdout)?status:await execute(node,[setup.launcher,'server','start','--configured'],serverOptions);
 return {...setup,server:server.stdout.trim(),connectionVerified:false,
  next:'Follow interface.onboarding now: prepare the initial Goal through the selected native operation, open its Web page (or the workspace URL while activation is pending), and give the matching short welcome. Preparation does not verify native activation.',
  interface:harnessGuidance(adapter.id)};
}
