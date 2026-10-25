// Tests run as a neutral caller. Run inside an agent conversation, the shell
// carries that conversation's identity, which the CLI would otherwise treat as
// the caller (and the PORT of whatever Web it last used, or Claude Desktop).
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installHiddenFailureCheck} from './hidden-failures.mjs';
for (const name of ['CHILL_AGENT_HARNESS','CHILL_AGENT_SESSION_ID','CHILL_AGENT_CONNECTION_GENERATION','CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID','CHILL_AGENT_DATA_DIR','PORT','CLAUDE_CODE_ENTRYPOINT'])
  delete process.env[name];

// A test that forgets to point at a fake must find nothing, never the developer's
// own Codex, Claude or data. Every path that derives from the home lands here.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'chill-test-')));
// Test doubles for Codex record protocol violations here (see test/codex-contract.mjs).
// A violation fails the run even when chill-agent swallowed the error it caused.
const contractLog = join(home, 'contract-violations.log');
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_DATA_HOME: join(home, '.local', 'share'),
  CHILL_AGENT_CODEX_PATH: join(home, 'no-codex'),
  CHILL_TEST_CONTRACT_LOG: contractLog,
});
process.on('exit', () => {
  let text = '';
  try { text = readFileSync(contractLog, 'utf8'); } catch { /* nothing was recorded */ }
  rmSync(home, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  if (!text) return;
  process.stderr.write(`\nCodex contract violations recorded during this test file:\n${text}`);
  process.exitCode = 1;
});
installHiddenFailureCheck(join(home, 'hidden-failures.jsonl'));
