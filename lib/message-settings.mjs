import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { dataDirectory, writeJsonAtomically } from './goal-store.mjs';

const defaults = () => ({ remote: { mode: 'off' }, notifications: { enabled: false } });
const settingsPath = (section, directory) => join(directory, 'settings', `${section}.json`);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown settings field. Store only the documented non-secret fields.');
}
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

export function validateRemote(value) {
  if (!object(value) || !['off', 'quick', 'named'].includes(value.mode)) throw new Error('Remote mode must be off, quick, or named.');
  if (value.mode !== 'named') { exactKeys(value, ['mode']); return { mode: value.mode }; }
  exactKeys(value, ['mode', 'url', 'tunnelId', 'credentialsFile', 'accessTeam', 'accessAud']);
  const url = new URL(text(value.url, 'HTTPS URL'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.trycloudflare.com')) throw new Error('Use a fixed HTTPS origin without a path, port, or credentials.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.tunnelId)) throw new Error('Use the named tunnel UUID.');
  const credentialsFile = text(value.credentialsFile, 'credentials file path', 4096);
  if (!isAbsolute(credentialsFile)) throw new Error('credentialsFile must be absolute. Keep the secret file outside the repository.');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.accessTeam)) throw new Error('Use the Cloudflare Access team name, without its domain.');
  if (!Array.isArray(value.accessAud) || !value.accessAud.length || value.accessAud.length > 10 || value.accessAud.some(aud => typeof aud !== 'string' || !/^[a-f0-9]{64}$/i.test(aud))) throw new Error('accessAud must contain Access application audience tags.');
  return { mode: 'named', url: url.origin, tunnelId: value.tunnelId, credentialsFile, accessTeam: value.accessTeam, accessAud: [...new Set(value.accessAud)] };
}

export function validateNotifications(value) {
  if (!object(value) || typeof value.enabled !== 'boolean') throw new Error('notifications.enabled must be true or false.');
  if (!value.enabled) { exactKeys(value, ['enabled']); return { enabled: false }; }
  exactKeys(value, ['enabled', 'tool', 'destination', 'on']);
  const tool = text(value.tool, 'tool identifier');
  const destination = text(value.destination, 'destination', 500);
  if (!Array.isArray(value.on) || !value.on.length || value.on.some(event => !['comment', 'letter'].includes(event))) throw new Error('Notification events are comment and letter.');
  return { enabled: true, tool, destination, on: [...new Set(value.on)] };
}

async function readSetting(section, validate, fallback, directory) {
  try { return validate(JSON.parse(await readFile(settingsPath(section, directory), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

export async function readNotificationSettings(directory = dataDirectory()) {
  return readSetting('notifications', validateNotifications, { enabled: false }, directory);
}

export async function readMessageSettings(directory = dataDirectory()) {
  const result = defaults();
  for (const [section, validate] of [['remote', validateRemote], ['notifications', validateNotifications]]) {
    result[section] = await readSetting(section, validate, result[section], directory);
  }
  return result;
}

// Separate files prevent a remote change from overwriting a notification setting.
export async function saveMessageSetting(section, value, directory = dataDirectory()) {
  const validate = { remote: validateRemote, notifications: validateNotifications }[section];
  if (!validate) throw new Error('Choose remote or notifications.');
  const saved = validate(value);
  await writeJsonAtomically(settingsPath(section, directory), saved);
  return saved;
}

export function namedTunnelConfig(remote, port) {
  const config = validateRemote(remote);
  if (config.mode !== 'named') throw new Error('A named tunnel configuration is required.');
  return { tunnel: config.tunnelId, 'credentials-file': config.credentialsFile,
    ingress: [{ hostname: new URL(config.url).hostname, service: `http://127.0.0.1:${port}`,
      originRequest: { access: { required: true, teamName: config.accessTeam, audTag: config.accessAud } } },
    { service: 'http_status:404' }] };
}
