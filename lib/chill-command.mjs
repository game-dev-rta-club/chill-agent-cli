import {realpathSync,statSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from './goal-store.mjs';
import {stableNodePath} from './node-path.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// The command an agent types to reach this store's chill.
export const command = () => {
  const directory=dataDirectory(),root=fileURLToPath(new URL('../',import.meta.url));
  // Installed hooks keep the setup prefix across updates. A checkout or a
  // different store must keep its own entry, not silently use another runtime.
  try {
    const canonical=realpathSync(root),entry=join(directory,'runtime/chill');
    if (/^[a-f0-9]{64}$/.test(basename(canonical)) && dirname(canonical)===realpathSync(join(directory,'runtime/packages')) && statSync(entry).isFile()) return quote(entry);
  } catch {}
  return `CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(stableNodePath())} ${quote(join(root,'bin/chill-entry.mjs'))}`;
};
