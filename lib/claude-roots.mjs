// Roots owned by a Claude conversation. The adapter builds the stored
// connection identity; the Goal store treats it as opaque.
import {createConnectedRoot,transferConnectedRoot} from './goal-store.mjs';

const identity=connection=>{
  if(connection?.harnessId!=='claude-code')throw Error('Invalid Claude connection.');
  return {harnessId:'claude-code',sessionId:connection.sessionId,contextId:connection.contextId};
};
export const createClaudeRoot=(input,connection,requestId)=>createConnectedRoot(input,identity(connection),requestId);
export const transferClaudeRoot=(id,from,to,requestId)=>transferConnectedRoot(id,from,identity(to),requestId);
