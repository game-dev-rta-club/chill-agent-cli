// Opt-in browser trial. PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --import ./test/isolate-env.mjs --test test/waiting-order-web.mjs
// isolate-env.mjs moves HOME; set PLAYWRIGHT_BROWSERS_PATH when the browsers live under the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {drivers} from './harness-drivers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');

test('a Waiting comment shows below the running agent activity',async t=>{
  const s=await drivers.find(d=>d.name==='Claude Code').start(t);
  await s.agentStartsResponse();await s.agentSelectsWork();
  await s.agentComments('Working on it');
  const event=await s.saveFeedback('After this');
  assert.equal(await s.shown(event),'waiting');
  const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  t.after(()=>server.kill());
  const url=await new Promise(resolve=>server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);}));
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(`${url}/#/goal/${s.goalId}`);
  await page.locator('#goal-activity').getByText('Running',{exact:true}).waitFor();
  const order=await page.locator('#goal-activity, .comment-event').evaluateAll(items=>items.map(li=>li.id==='goal-activity'?'activity':li.classList.contains('is-waiting')?'waiting':'comment'));
  assert.deepEqual(order,['comment','activity','waiting']);
});
