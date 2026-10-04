import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDirectory() {
  if (process.env.CHILL_AGENT_DATA_DIR) return resolve(process.env.CHILL_AGENT_DATA_DIR);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'chill-agent');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'chill-agent');
}
