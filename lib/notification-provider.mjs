import {projectExtensionEnabled} from './project-workspace.mjs';
import {readFile} from 'node:fs/promises';

// Optional application policy, loaded by the same trusted runtime manifest as extensions.
// Do not fall back to global preferences when the configured provider fails.
let provider;
export async function notificationProvider() {
  if(!projectExtensionEnabled('notifications')&&!projectExtensionEnabled('web-notifications'))return {settings:async()=>({enabled:false,on:[]}),prepare:async()=>({enabled:false,reason:'Notifications are disabled for this project.'}),configure:async()=>{throw Error('Notifications are disabled for this project.');},result:async()=>{throw Error('Notifications are disabled for this project.');}};
  if (!provider) provider = (async () => {
    let manifest;
    try { manifest = JSON.parse(await readFile(new URL('../extensions.json', import.meta.url), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!manifest.notificationProvider) return null;
    const module = await import(new URL(manifest.notificationProvider, new URL('../', import.meta.url)));
    for (const method of ['settings', 'configure', 'prepare', 'result']) {
      if (typeof module.notifications?.[method] !== 'function') throw Error(`Invalid notification provider: missing ${method}`);
    }
    return module.notifications;
  })();
  return provider;
}
