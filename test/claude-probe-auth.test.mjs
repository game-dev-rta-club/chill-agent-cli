import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {probeAuthSettings} from '../scripts/claude-probe-auth.mjs';

async function fixture(t,value) {
  const dir=await mkdtemp(join(tmpdir(),'chill-probe-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'settings.json'),body=JSON.stringify(value);await writeFile(path,body);
  return {path,body};
}
test('explicit auth import keeps endpoint and credentials together without importing hooks or permissions',async t=>{
  const f=await fixture(t,{model:'native-preference',env:{ANTHROPIC_API_KEY:'dummy-test-key',ANTHROPIC_AUTH_TOKEN:'dummy-test-token',ANTHROPIC_BASE_URL:'https://example.invalid',ANTHROPIC_CUSTOM_HEADERS:'Test: dummy',MAX_THINKING_TOKENS:'42',ARBITRARY:'not-imported'},hooks:{SessionStart:['do not execute']},permissions:{defaultMode:'bypassPermissions'}});
  const result=await probeAuthSettings(f.path);
  assert.deepEqual(result,{model:'native-preference',env:{ANTHROPIC_API_KEY:'dummy-test-key',ANTHROPIC_AUTH_TOKEN:'dummy-test-token',ANTHROPIC_BASE_URL:'https://example.invalid',ANTHROPIC_CUSTOM_HEADERS:'Test: dummy'}});
  assert.equal(await readFile(f.path,'utf8'),f.body);
});
test('unsupported native auth does not run helpers or fall back to a different provider',async t=>{
  for(const value of [{apiKeyHelper:'do not execute',env:{ANTHROPIC_API_KEY:'dummy'}},{env:{CLAUDE_CODE_USE_BEDROCK:'1',ANTHROPIC_API_KEY:'dummy'}},{env:{ANTHROPIC_BASE_URL:'https://example.invalid'}},{env:[]}]){
    const f=await fixture(t,value);await assert.rejects(probeAuthSettings(f.path));
  }
});
test('bad settings produce no secret-bearing parser or value errors',async t=>{
  const f=await fixture(t,{});await writeFile(f.path,'{"env":{"ANTHROPIC_API_KEY":"dummy-secret-do-not-print",');
  await assert.rejects(probeAuthSettings(f.path),error=>!error.message.includes('dummy-secret')&&/Could not read/.test(error.message));
  await writeFile(f.path,JSON.stringify({env:{ANTHROPIC_API_KEY:['dummy-secret']}}));
  await assert.rejects(probeAuthSettings(f.path),error=>!error.message.includes('dummy-secret')&&/Invalid/.test(error.message));
});
