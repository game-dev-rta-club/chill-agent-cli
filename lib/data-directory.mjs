import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDirectory() {
  if (process.env.CHILL_AGENT_DATA_DIR) return resolve(process.env.CHILL_AGENT_DATA_DIR);
  return defaultDataDirectory();
}

export function defaultDataDirectory() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'chill-agent');
  // Not AppData: packaged (MSIX) apps such as Claude Desktop have their AppData
  // writes redirected into a private package folder, so Web started by Task
  // Scheduler or another harness would see different data. The user profile
  // is not virtualized, so every caller shares one directory.
  if (platform() === 'win32') return join(homedir(), '.chill-agent');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'chill-agent');
}
