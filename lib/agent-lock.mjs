import {join} from 'node:path';
import {withStoreLock} from './storage.mjs';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';

// One lock per chat for everything that changes what the chat is told or doing:
// controls, holds, and continuation requests.
export const withAgentControlLock=(id,run)=>withStoreLock(join(workspaceDirectory(),'locks',`agent-control-${validThreadId(id)}`),run);
