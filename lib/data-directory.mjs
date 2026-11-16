import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

// Each project keeps its data in its own folder, projects/<hash> under the
// shared folder (defaultDataDirectory), chosen by CHILL_AGENT_DATA_DIR, which
// the project's own command sets. The shared folder once held one workspace
// for every project; it is no longer a data folder, and what it holds stays as it is.
const how='Run chill through the project\'s own command, which `setup status --project <folder>` prints, or set CHILL_AGENT_DATA_DIR.';
const same=(a,b)=>['darwin','win32'].includes(platform())?a.toLowerCase()===b.toLowerCase():a===b;
export function dataDirectory() {
  const chosen=process.env.CHILL_AGENT_DATA_DIR;
  if(!chosen)throw Error(`No project is selected. ${how}`);
  const directory=resolve(chosen);
  if(same(directory,resolve(defaultDataDirectory())))throw Error(`The shared chill-agent folder is no longer a data folder; each project has its own under projects/. ${how}`);
  return directory;
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
