#!/usr/bin/env node
import {workspacePort} from '../lib/project-workspace.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory, readFeedback, readGoal } from '../lib/goal-store.mjs';
import { readMessageSettings, saveMessageSetting } from '../lib/message-settings.mjs';
import { notificationProvider } from '../lib/notification-provider.mjs';

async function main() {
  if (showHelp('settings', process.argv.slice(2))) return;
  const [command = 'show', ...args] = process.argv.slice(2);
  const values = parseOptions(`settings ${command}`, args);
  const provider = command === 'remote' ? null : await notificationProvider();
  if (command === 'show') {
    const settings = await readMessageSettings();
    if (provider) settings.notifications = await provider.settings(values['--id']);
    return console.log(JSON.stringify(settings, null, 2));
  }
  if (provider && command === 'notifications') {
    if (!values['--id']) throw Error('Use --id <GOAL> to configure this Root only.');
    const input = values['--file'] ? JSON.parse(await readFile(values['--file'], 'utf8')) : {enabled:false};
    return console.log(JSON.stringify(await provider.configure(values['--id'], input), null, 2));
  }
  if (command === 'notice-result') {
    if (!provider) throw Error('This runtime does not provide notification history.');
    return console.log(JSON.stringify(await provider.result(values['--id'], values['--notice'], values['--outcome']), null, 2));
  }
  if (provider && command === 'notice') return console.log(JSON.stringify(await provider.prepare(values['--id'], Number(values['--event'])), null, 2));
  if (['remote', 'notifications'].includes(command) && values['--file']) {
    const saved = await saveMessageSetting(command, JSON.parse(await readFile(values['--file'], 'utf8')));
    console.log(JSON.stringify(saved, null, 2));
    if (command === 'remote') console.log('Saved for the next server start. Restart a running server to apply this change.');
    return;
  }
  if (['remote', 'notifications'].includes(command) && values['--off']) {
    await saveMessageSetting(command, command === 'remote' ? { mode: 'off' } : { enabled: false });
    console.log(command === 'remote' ? 'Remote disabled for the next start. Stop/restart the running server to close its tunnel now.' : 'Notifications disabled.');
    return;
  }
  if (command === 'notice') {
    const { '--id': id, '--event': eventId } = values;
    const event=(await readFeedback()).find(e=>e.goalId===id&&e.id===Number(eventId)&&e.author==='agent');
    if(!event)throw new Error('Agent comment not found. Save it before preparing a notification.');
    const when=event.type;
    const settings = await readMessageSettings();
    if (!settings.notifications.enabled || !settings.notifications.on.includes(when)) return console.log(JSON.stringify({ enabled: false }));
    // Only advertise the connector actually running, not a configured/stale URL.
    let origin = null;
    try {
      const live = JSON.parse(await readFile(join(dataDirectory(), 'runtime', `web-${workspacePort()}`, 'tunnel.json'), 'utf8'));
      process.kill(live.pid, 0);
      if (settings.remote.mode === 'quick' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(live.url)
        || settings.remote.mode === 'named' && live.url === settings.remote.url) origin = live.url;
    } catch { /* A stopped connector does not have a usable mobile link. */ }
    console.log(JSON.stringify({ ...settings.notifications, when, goalId: id, eventId:event.id, title:event.title || (await readGoal(id)).title,
      url: origin ? `${origin}/#/goal/${id}${when==='letter'?`/letter/${event.id}`:''}` : null,
      warning: origin ? null : 'No running mobile URL. Resolve the link before sending a phone notification.' }, null, 2));
    return;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
