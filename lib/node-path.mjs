import {realpathSync} from 'node:fs';

// Homebrew runs Node from a versioned Cellar folder that `brew upgrade` deletes.
// Commands written into hooks, launchd jobs and agent handoffs use the formula's
// stable `opt` link to the same binary instead. Other installs keep their path.
export function stableNodePath(executable=process.execPath) {
  const cellar=/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(executable);
  if(!cellar)return executable;
  const link=`${cellar[1]}/opt/${cellar[2]}/bin/node`;
  try { return realpathSync(link)===realpathSync(executable)?link:executable; }
  catch { return executable; }
}
