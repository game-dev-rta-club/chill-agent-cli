#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {workspacePort} from '../lib/project-workspace.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from '../lib/goal-store.mjs';
import { readMessageSettings, saveMessageSetting } from '../lib/message-settings.mjs';
import { notificationProvider } from '../lib/notification-provider.mjs';
import { createPublicAccess } from '../lib/public-access.mjs';
import { publicLinkOn } from '../lib/public-link-extension.mjs';

// Only advertise the connector actually running, not a configured/stale URL.
async function liveOrigin(remote) {
  try {
    const live = JSON.parse(await readFile(join(dataDirectory(), 'runtime', `web-${workspacePort()}`, 'tunnel.json'), 'utf8'));
    process.kill(live.pid, 0);
    if (remote.mode === 'quick' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(live.url)
      || remote.mode === 'named' && live.url === remote.url) return live.url;
  } catch { /* A stopped connector does not have a usable mobile link. */ }
  return null;
}

async function main() {
  if (showHelp('settings', process.argv.slice(2))) return;
  const [command = 'show', ...args] = process.argv.slice(2);
  const values = parseOptions(`settings ${command}`, args);
  const provider = ['remote', 'access-code'].includes(command) ? null : await notificationProvider();
  if (command === 'show') {
    const settings = await readMessageSettings();
    if (provider) settings.notifications = await provider.settings(values['--id']);
    return console.log(JSON.stringify(settings, null, 2));
  }
  // Notifications are per Root, through the runtime's provider; there is no
  // global switch to set and no notice without one.
  if (!provider && ['notifications', 'notice'].includes(command)) throw Error('This runtime does not provide notifications.');
  if (command === 'notifications') {
    if (!values['--id']) throw Error('Use --id <GOAL> to configure this Root only.');
    const input = values['--file'] ? JSON.parse(await readFile(values['--file'], 'utf8')) : {enabled:false};
    return console.log(JSON.stringify(await provider.configure(values['--id'], input), null, 2));
  }
  if (command === 'notice-result') {
    if (!provider) throw Error('This runtime does not provide notification history.');
    return console.log(JSON.stringify(await provider.result(values['--id'], values['--notice'], values['--outcome']), null, 2));
  }
  if (command === 'notice') return console.log(JSON.stringify(await provider.prepare(values['--id'], Number(values['--event'])), null, 2));
  if (command === 'remote' && values['--file']) {
    const saved = await saveMessageSetting(command, JSON.parse(await readFile(values['--file'], 'utf8')));
    console.log(JSON.stringify(saved, null, 2));
    console.log('Saved for the next server start. Restart a running server to apply this change.');
    return;
  }
  if (command === 'remote' && values['--off']) {
    await saveMessageSetting(command, { mode: 'off' });
    console.log('Remote disabled for the next start. Stop/restart the running server to close its tunnel now.');
    return;
  }
  // The code a device types after opening the link, for an agent to hand to the user.
  if (command === 'access-code') {
    const origin = await publicLinkOn() ? await liveOrigin((await readMessageSettings()).remote) : null;
    if (!origin) throw Error('Public link is not running. Turn it On in More → Public link on this computer, then run this again.');
    return console.log(JSON.stringify({ ...await createPublicAccess().issued(), link: `${origin}/` }, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
