import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {dataDirectory,defaultDataDirectory} from '../lib/data-directory.mjs';
import {workspacePort} from '../lib/project-workspace.mjs';

// Only a project's own folder is a data folder: with none selected, or with the
// shared folder that once held every project's workspace, nothing is read or written.
test('a command needs its project selected, and the shared folder is not a project', t => {
  const saved = process.env.CHILL_AGENT_DATA_DIR;
  t.after(() => { process.env.CHILL_AGENT_DATA_DIR = saved; });
  const project = join(defaultDataDirectory(), 'projects', 'a1');
  process.env.CHILL_AGENT_DATA_DIR = project;
  assert.equal(dataDirectory(), project);
  delete process.env.CHILL_AGENT_DATA_DIR;
  assert.throws(dataDirectory, /No project is selected.*setup status --project/);
  for (const shared of [defaultDataDirectory(), defaultDataDirectory() + '/']) {
    process.env.CHILL_AGENT_DATA_DIR = shared;
    assert.throws(dataDirectory, /no longer a data folder/);
  }
  assert.equal(workspacePort({}), 4173, 'with no project, no profile is read for its port');
});
