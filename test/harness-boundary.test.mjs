import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Core code works through the agent connection interface (lib/agents) and must
// not tell harnesses apart. Harness-specific code lives in adapters.
// Entry points name a harness only because the user or the native app picks
// it: setup's --harness option, its help, and Codex's own hook command.
const root=fileURLToPath(new URL('..',import.meta.url));
const adapter=file=>/^lib\/agents\/(?!index\.mjs)|^lib\/(claude-|codex-|desktop-settings)|^extensions\/harnesses\//.test(file);
const entries=new Set(['bin/chill-hook.mjs','bin/chill-setup.mjs','lib/cli-help.mjs']);
const names=/claude-code|codex-desktop|CODEX_THREAD_ID|nativeConnection|harnessId/;

test('core code does not name a harness; only adapters and harness entry points do',()=>{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','lib','public','bin','server.mjs'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.(mjs|js)$/.test(f)&&!adapter(f));
 const naming=files.filter(f=>names.test(readFileSync(new URL(f,`file://${root}/`),'utf8')));
 assert.deepEqual(naming.filter(f=>!entries.has(f)),[],'a core file names a harness; move that code into an adapter');
 assert.deepEqual([...entries].filter(f=>!naming.includes(f)),[],'a listed entry point no longer names a harness; remove it from the list');
});
