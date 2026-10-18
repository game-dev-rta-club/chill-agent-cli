import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeRmGuard,unguardedRemoval} from '../lib/claude-rm-guard.mjs';
import {claudeHook} from './claude-fixtures.mjs';

test('removals Claude Code would stop for are found; guarded and literal ones pass',()=>{
 for(const c of ['rm -f $S/*.png','rm -rf "$DIR"/*','rm -rf "$DIR/"*','rm -rf $DIR/','x; rm -rf ${D}/*','echo $(rm -rf $1/*)','rm -f $S/*.png; echo ok','if true; then rm -rf $T/*; fi'])
  assert.ok(unguardedRemoval(c),c);
 for(const c of ['rm -f "${S:?}"/*.png','rm -rf $DIR','rm -f build/*.png','rm -rf /tmp/x/*','cp $S/*.png out/','rm -f a.json; uloop x --code "$A/*"','S=/tmp/a; rm -rf $S; mkdir -p $S','find . -name x | xargs rm',undefined])
  assert.equal(unguardedRemoval(c),null,String(c));
});

test('the PreToolUse hook asks Claude to rewrite, never approves, and ignores other tools',()=>{
 const bash=command=>claudeHook('PreToolUse',{tool_input:{command}});
 const out=claudeRmGuard(bash('rm -f $S/*.png'));
 assert.equal(out.hookSpecificOutput.permissionDecision,'deny');assert.match(out.hookSpecificOutput.permissionDecisionReason,/\$\{DIR:\?\}/);
 assert.equal(claudeRmGuard(bash('ls')),null);
 assert.equal(claudeRmGuard(claudeHook('PreToolUse',{tool_name:'Read',tool_input:{file_path:'/x'}})),null);
 assert.equal(claudeRmGuard(claudeHook('PostToolUse',{tool_input:{command:'rm -f $S/*'}})),null);
});
