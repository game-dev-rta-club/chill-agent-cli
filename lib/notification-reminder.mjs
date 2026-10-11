import { fileURLToPath } from 'node:url';
import { dataDirectory } from './data-directory.mjs';
import { readNotificationSettings } from './message-settings.mjs';
import { notificationProvider } from './notification-provider.mjs';
import { stableNodePath } from './node-path.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Read shared preferences at each hand-off; never remember a recipient per chat
// or send a message here. Bad optional settings must not block saved work.
export async function notificationReminder({ goalId, eventId, when, directory = dataDirectory() } = {}) {
  const cli = fileURLToPath(new URL('../bin/chill-settings.mjs', import.meta.url));
  const command = `CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(stableNodePath())} ${quote(cli)}`;
  let settings;
  let provider;
  try { provider = await notificationProvider(); settings = provider ? await provider.settings(goalId) : await readNotificationSettings(directory); }
  catch {
    return `Could not read saved user notification preferences. Work is still saved. Check with ${command} show before sending; do not guess the destination.`;
  }
  if (!settings.enabled || when && !settings.on.includes(when)) return '';
  if (provider) return `After saving a Letter or a Comment with an actual result, prepare a notification for that saved event:\n${command} notice --id ${goalId || '<goal-id>'} --event ${eventId || '<saved-event-id>'}\nIf the response says handled or delivery is web-push, delivery is already handled: do not send it again. Otherwise, if enabled, send its exact message once through the returned host tool to the returned destination, then use the returned resultCommand with sent, failed or unconfirmed. If disabled, skip it. Do not notify routine progress or AutoContinue no-work; do not retry an uncertain send or substitute another service. This reminder sends nothing.`;
  return `User notifications are configured (${settings.on.join(', ')}), shared across chats. After saving a Comment or Letter selected for notification, read the current tool, recipient and link:\n` +
    `${command} notice --id ${goalId || '<goal-id>'} --event ${eventId || '<saved-event-id>'}\n` +
    `Use the event just saved. If enabled, send once through the configured available host tool. This reminder sends nothing. If disabled, skip sending; if the tool is unavailable or delivery is uncertain, report that on the Goal without substituting a service or blindly resending.`;
}
