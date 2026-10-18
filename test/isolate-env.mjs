// Tests run as a neutral caller. Run inside an agent conversation, the shell
// carries that conversation's identity, which the CLI would otherwise treat as
// the caller (and the PORT of whatever Web it last used, or Claude Desktop).
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installHiddenFailureCheck} from './hidden-failures.mjs';
for (const name of ['CHILL_AGENT_HARNESS','CHILL_AGENT_SESSION_ID','CHILL_AGENT_CONNECTION_GENERATION','CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID','CHILL_AGENT_DATA_DIR','PORT','CLAUDE_CODE_ENTRYPOINT'])
  delete process.env[name];

// A test that forgets to point at a fake must find nothing, never the developer's
// own Codex, Claude or data. Every path that derives from the home lands here.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'chill-test-')));
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_DATA_HOME: join(home, '.local', 'share'),
  CHILL_AGENT_CODEX_PATH: join(home, 'no-codex'),
});
process.on('exit', () => rmSync(home, {recursive: true, force: true}));
installHiddenFailureCheck(join(home, 'hidden-failures.jsonl'));
