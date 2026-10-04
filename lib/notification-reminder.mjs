import { fileURLToPath } from 'node:url';
import { dataDirectory } from './data-directory.mjs';
import { readNotificationSettings } from './message-settings.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Read shared preferences at each hand-off; never remember a recipient per chat
// or send a message here. Bad optional settings must not block saved work.
export async function notificationReminder({ goalId, eventId, when, directory = dataDirectory() } = {}) {
  const cli = fileURLToPath(new URL('../bin/chill-settings.mjs', import.meta.url));
  const command = `CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(cli)}`;
  let settings;
  try { settings = await readNotificationSettings(directory); }
  catch {
    return `Could not read saved user notification preferences. Work is still saved. Check with ${command} show before sending; do not guess the destination.`;
  }
  if (!settings.enabled || when && !settings.on.includes(when)) return '';
  return `User notifications are configured (${settings.on.join(', ')}), shared across chats. After saving a Comment or Letter selected for notification, read the current tool, recipient and link:\n` +
    `${command} notice --id ${goalId || '<goal-id>'} --event ${eventId || '<saved-event-id>'}\n` +
    `Use the event just saved. If enabled, send once through the configured available host tool. This reminder sends nothing. If disabled, skip sending; if the tool is unavailable or delivery is uncertain, report that on the Goal without substituting a service or blindly resending.`;
}
