import {createCodexDesktopConnection} from './codex-desktop-connection.mjs';

export function connectionKey(connection) {
  if(!connection)return null;
  if(typeof connection.harnessId!=='string'||!connection.harnessId||typeof connection.sessionId!=='string'||!connection.sessionId)
    throw Error('A harness and session identity are required.');
  return JSON.stringify([connection.harnessId,connection.sessionId]);
}

// Existing Roots still bind a Codex Desktop chat. Additional harness bindings
// require their own qualified entry point; a model name never selects a harness.
export function resolveAgentConnection(root) {
  return root.threadId?createCodexDesktopConnection(root.threadId):null;
}
