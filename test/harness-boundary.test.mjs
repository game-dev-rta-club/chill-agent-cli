import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Core code works through the agent connection interface (lib/agents) and must
// not tell harnesses apart. Harness-specific code lives in adapters. Files that
// still name a harness are listed here until their stage of the refactor moves
// that code behind the interface; the list only shrinks.
const root=fileURLToPath(new URL('..',import.meta.url));
const adapter=file=>/^lib\/agents\/(?!index\.mjs)|^lib\/(claude-|codex-|desktop-settings)|^extensions\/harnesses\//.test(file);
const pending=new Set([
 'bin/chill-hook.mjs','bin/chill-monitor.mjs','bin/chill-setup.mjs',
 'lib/agent-connection.mjs','lib/agent-observation.mjs','lib/agent-presence.mjs','lib/cli-help.mjs',
 'lib/continuation-extension.mjs','lib/continuation-monitor.mjs','lib/delivery.mjs','lib/extension-api.mjs',
 'lib/goal-execution.mjs','lib/goal-store.mjs','lib/notifications.mjs','lib/web-notifications.mjs',
]);
const names=/claude-code|codex-desktop|CODEX_THREAD_ID|nativeConnection|harnessId/;

test('core code does not name a harness outside the listed files still being moved',()=>{
 const files=execFileSync('git',['ls-files','lib','public','bin','server.mjs'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.(mjs|js)$/.test(f)&&!adapter(f));
 const naming=files.filter(f=>names.test(readFileSync(new URL(f,`file://${root}/`),'utf8')));
 assert.deepEqual(naming.filter(f=>!pending.has(f)),[],'a core file names a harness; move that code into an adapter');
 assert.deepEqual([...pending].filter(f=>!naming.includes(f)),[],'a listed file no longer names a harness; remove it from the list');
});
