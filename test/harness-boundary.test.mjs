import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';

// Core code works through the agent connection interface (lib/agents/index.mjs)
// and must not tell harnesses apart. Harness-specific code lives in adapters.
const root=fileURLToPath(new URL('..',import.meta.url));
const adapter=file=>/^lib\/agents\/(?!index\.mjs)|^lib\/(claude-|codex-|desktop-settings)|^extensions\/harnesses\//.test(file);
// The two doors: the agent interface, and the registry that selects a harness by ID.
const doors=new Set(['lib/agents/index.mjs','extensions/harnesses/index.mjs']);
const adapterCode=file=>adapter(file)&&!doors.has(file);

// Entry points name a harness only because the user or the native app picks it.
const entries=new Set(['bin/chill-hook.mjs','bin/chill-setup.mjs','lib/cli-help.mjs']);
const names=/claude-code|codex-desktop|CODEX_THREAD_ID|nativeConnection|harnessId/;

// Core files that may import adapter code directly, each for the reason given.
const mayImportAdapters=new Map([
 ['bin/chill-hook.mjs',"Codex's own hook command; Codex is the app that runs it"],
 ['bin/chill-setup.mjs','setup prepares the harness the user names with --harness'],
 ['bin/chill-connection.mjs',"its hook subcommands are Claude Code's own hook commands"],
]);

const importSpecifier=/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]*)['"]/gm;
// Specifiers built at run time (import(new URL(...))) are not visible here.
export function adapterImports(sources){
 const found=[];
 for(const [file,source] of Object.entries(sources)){
  if(adapterCode(file)||doors.has(file))continue;
  for(const [,specifier] of source.matchAll(importSpecifier)){
   const target=posix.join(posix.dirname(file),specifier);
   if(adapterCode(target))found.push(`${file} -> ${target}`);
  }
 }
 return found;
}

const files=()=>execFileSync('git',['ls-files','--cached','--others','--exclude-standard','lib','public','bin','server.mjs','extensions'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.(mjs|js)$/.test(f));
const read=file=>readFileSync(new URL(file,`file://${root}/`),'utf8');

test('core code does not name a harness; only adapters and harness entry points do',()=>{
 const core=files().filter(f=>!adapter(f));
 const naming=core.filter(f=>names.test(read(f)));
 assert.deepEqual(naming.filter(f=>!entries.has(f)),[],'a core file names a harness; move that code into an adapter');
 assert.deepEqual([...entries].filter(f=>!naming.includes(f)),[],'a listed entry point no longer names a harness; remove it from the list');
});

test('core code reaches adapters only through lib/agents/index.mjs',()=>{
 const sources=Object.fromEntries(files().map(f=>[f,read(f)]));
 const found=adapterImports(sources);
 const owner=entry=>entry.split(' -> ')[0];
 assert.deepEqual(found.filter(entry=>!mayImportAdapters.has(owner(entry))),[],'a core file imports adapter code directly; go through lib/agents/index.mjs');
 assert.deepEqual([...mayImportAdapters.keys()].filter(file=>!found.some(entry=>owner(entry)===file)),[],'a listed entry point no longer imports adapter code; remove it from the list');
});

test('the import check catches static, dynamic and re-export imports of adapter code',()=>{
 const sources={
  'lib/core-a.mjs':"import {withCodex} from './codex-client.mjs';",
  'lib/core-b.mjs':"export {x} from './agents/codex-hold.mjs';",
  'lib/core-c.mjs':"const m=await import('./agents/claude.mjs');",
  'lib/core-d.mjs':"import {agentFor} from './agents/index.mjs';import {readFeedbackHold} from './feedback-hold.mjs';",
  'lib/claude-actions.mjs':"import {x} from './codex-client.mjs';",
  'bin/tool.mjs':"import '../lib/codex-client.mjs';",
  'bin/session.mjs':"import {harness} from '../extensions/harnesses/index.mjs';",
 };
 assert.deepEqual(adapterImports(sources),[
  'lib/core-a.mjs -> lib/codex-client.mjs',
  'lib/core-b.mjs -> lib/agents/codex-hold.mjs',
  'lib/core-c.mjs -> lib/agents/claude.mjs',
  'bin/tool.mjs -> lib/codex-client.mjs',
 ]);
});
