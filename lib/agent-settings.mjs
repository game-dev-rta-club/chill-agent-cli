import {connectionKey} from './agent-connection.mjs';

// Normalized connection snapshots; no harness RPC names or model enums here.
export function createAgentSettingsStore({now=Date.now,ttl=10000,limit=30}={}) {
  const snapshots=new Map(),saving=new Set();
  const invalidate=connection=>snapshots.delete(connectionKey(connection));
  async function read(connection,{fresh=false}={}) {
    const key=connectionKey(connection),existing=snapshots.get(key);
    if(!fresh&&existing&&now()-existing.at<ttl)return existing.promise;
    const promise=Promise.resolve().then(()=>connection.readSnapshot());
    const entry={at:now(),promise};snapshots.set(key,entry);
    if(snapshots.size>limit)snapshots.delete(snapshots.keys().next().value);
    try{return await promise;}catch(error){if(snapshots.get(key)===entry)snapshots.delete(key);throw error;}
  }
  async function save(connection,input,{assertCurrent}) {
    const key=connectionKey(connection);
    if(saving.has(key))throw Error('Saving…');
    saving.add(key);
    try {
      const data=await read(connection,{fresh:true}),model=data.models.find(m=>m.id===input.model);
      if(!model||!model.efforts.includes(input.effort))throw Error('Choose a supported model and reasoning level.');
      if(!data.settings||data.settings.model!==input.expected?.model||data.settings.reasoning!==input.expected?.effort)throw Error('Settings changed. Refresh to retry.');
      if(!connection.saveSettings||!await connection.canSaveSettings?.(data))throw Error('Settings are read-only for this connection.');
      await assertCurrent();
      if(await connection.saveSettings({model:input.model,effort:input.effort},input.expected)!==true)throw Error('Could not save. Refresh to retry.');
      const after=await read(connection,{fresh:true});
      await assertCurrent();
      if(after.settings?.model!==input.model||after.settings?.reasoning!==input.effort)throw Error('Save unconfirmed. Refresh to check.');
      return after;
    } finally {saving.delete(key);invalidate(connection);}
  }
  return {read,save,invalidate};
}
