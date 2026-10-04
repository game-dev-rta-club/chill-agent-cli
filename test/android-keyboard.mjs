// Opt-in native Android Chrome test on a disposable emulator (not a phone).
// ANDROID_SERIAL=emulator-5580 ADB_PATH=/path/to/adb PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/android-keyboard.mjs
// Optional BEFORE_ASSETS=/path/to/previous/public enables a before/after comparison.
// Uses temporary Goals and fake Codex. Closes Chrome on the selected emulator.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {once} from 'node:events';
const {_android: android} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const exec = promisify(execFile);
const serial=process.env.ANDROID_SERIAL;
assert.match(serial || '',/^emulator-\d+$/,'Set ANDROID_SERIAL to a disposable, already booted emulator');
const adb=process.env.ADB_PATH || 'adb';
const adbRun=(...args)=>exec(adb,['-s',serial,...args]);
const devices=await android.devices();
const device=devices.find(d=>d.serial()===serial);
assert.ok(device,'The specified emulator must be running with Chrome and a software keyboard');
const root = await mkdtemp(join(tmpdir(),'chill-android-keyboard-'));
const env = {...process.env, CHILL_AGENT_DATA_DIR:join(root,'data'), CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname, PORT:'0'};
const body = join(root,'body.html');
await writeFile(body,'<section><h3>読みやすい計画</h3><p>選択範囲の確認をします。本文と会話を同じ場所から扱えます。</p></section>');
const cliFile = new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const cli = (...args) => exec(process.execPath,[cliFile,...args],{env});
await cli('create','--title','会話から次の一歩を決める');
await writeFile(join(root,'data/workspace/goals/1/brief.md'),await readFile(body,'utf8'));
await cli('brief','update','--id','1');
await cli('comment','--id','1','--text','返信の説明です。気になるところに注釈を付けてください。');
await cli('create','--title','別の計画');
await writeFile(join(root,'data/workspace/goals/2/brief.md'),await readFile(body,'utf8'));
await cli('brief','update','--id','2');
const server = spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});
const url = await new Promise((resolve,reject) => {
  server.stdout.on('data',data => {const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
  server.on('error',reject);
});
const port=new URL(url).port;
await adbRun('reverse',`tcp:${port}`,`tcp:${port}`);
let context;
const report=[];
console.log('emulator',device.model(),device.serial(),url,root);
try {
context=await device.launchBrowser({hasTouch:true});
const page=await context.newPage();
page.setDefaultTimeout(15000);
async function measure(label) {
  const metrics=await page.evaluate(()=>{
    const input=document.querySelector('#annotation-comment');
    const r=input.getBoundingClientRect();
    const form=document.querySelector('.annotation-form');
    const save=form.querySelector('[type=submit]').getBoundingClientRect();
    const style=getComputedStyle(input);
    const mirror=document.createElement('div');
    for(const name of ['width','fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','padding','border','boxSizing','whiteSpace','wordBreak','overflowWrap']) mirror.style[name]=style[name];
    Object.assign(mirror.style,{position:'fixed',left:'-10000px',top:'0',height:'auto',visibility:'hidden',whiteSpace:'pre-wrap'});
    const prefix=document.createTextNode(input.value.slice(0,input.selectionStart));
    const caret=document.createElement('span');caret.textContent='|';
    mirror.append(prefix,caret);document.body.append(mirror);
    const glyph=caret.getBoundingClientRect();const caretTop=r.top+glyph.top-input.scrollTop,caretBottom=r.top+glyph.bottom-input.scrollTop;
    mirror.remove();
    return {innerHeight,visualHeight:visualViewport.height,visualTop:visualViewport.offsetTop,fieldTop:r.top,fieldBottom:r.bottom,saveBottom:save.bottom,focused:document.activeElement===input,value:input.value,scrollTop:input.scrollTop,scrollHeight:input.scrollHeight,clientHeight:input.clientHeight,caretTop,caretBottom,inlineHeight:input.style.height};
  });
  console.log(label,{...metrics,value:`${metrics.value.length} characters`});report.push({label,...metrics});
  return metrics;
}
  for(const variant of process.env.BEFORE_ASSETS ? ['before','after'] : ['after']) {
    if(variant==='before') {
      for(const name of ['index.html','app.js','styles.css']) {
        const body=await readFile(join(process.env.BEFORE_ASSETS,name));
        await page.route(name==='index.html' ? `${url}/` : `**/${name}`,route=>route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'}));
      }
    } else await page.unrouteAll();
    await page.goto(`${url}/#/goal/1`);
    await page.reload();
    await page.locator('.conversation-form').waitFor();
    console.log('browser',await page.evaluate(()=>({ua:navigator.userAgent,fieldSizing:CSS.supports('field-sizing','content'),viewport:document.querySelector('meta[name=viewport]').content})));
    const beforeKeyboard=await page.evaluate(()=>visualViewport.height);
    const source=page.locator('.brief-body p');
    await source.scrollIntoViewIfNeeded();
    await source.evaluate(element=>{
      const node=document.createTreeWalker(element,NodeFilter.SHOW_TEXT).nextNode();
      const range=document.createRange();range.setStart(node,0);range.setEnd(node,7);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    await page.getByRole('button',{name:'Annotate selected text',exact:true}).tap();
    await page.waitForFunction(height=>visualViewport.height<height-150,beforeKeyboard);
    await page.waitForTimeout(700);
    const empty=await measure(`${variant}-empty`);
    await device.screenshot({path:join(root,`${variant}-empty.png`)});
    for(let line=0;line<35;line++) {await page.keyboard.type(`Line ${String(line).padStart(2,'0')}`);await page.keyboard.press('Enter');}
    await page.keyboard.type('Last line');
    await page.waitForTimeout(400);
    const long=await measure(`${variant}-long`);
    await device.screenshot({path:join(root,`${variant}-long.png`)});
    if(variant==='after') {
      assert.ok(Math.abs(empty.innerHeight-empty.visualHeight)<2,'layout viewport shrinks with the actual keyboard');
      assert.ok(empty.fieldTop>=empty.visualTop && empty.fieldBottom<=empty.visualTop+empty.visualHeight,'empty field visible before typing');
      assert.ok(empty.saveBottom<=empty.visualTop+empty.visualHeight,'Save visible with keyboard');
      assert.equal(empty.focused,true);
      assert.ok(long.caretTop>=long.fieldTop && long.caretBottom<=long.fieldBottom+1,'current caret remains visible');
    }
    await page.keyboard.press('Enter');
    const newline=await measure(`${variant}-newline`);
    await device.screenshot({path:join(root,`${variant}-newline.png`)});
    if(variant==='after') assert.ok(newline.caretTop>=newline.fieldTop && newline.caretBottom<=newline.fieldBottom+1,'caret visible immediately after newline');
    if(variant==='after') {
      // Mid-text editing and IME composition must not jump the selection to the end.
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('Edited ');
      const middle=await measure('after-edit-start');
      assert.ok(middle.value.startsWith('Edited Line 00'));
      assert.ok(middle.caretTop>=middle.fieldTop && middle.caretBottom<=middle.fieldBottom+1);
      const cdp=await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition',{text:'にほんご',selectionStart:4,selectionEnd:4});
      await cdp.send('Input.insertText',{text:'日本語'});
      await page.waitForFunction(()=>document.querySelector('#annotation-comment').value.startsWith('Edited 日本語Line 00'));
      const composed=await page.locator('#annotation-comment').inputValue();
      assert.ok(composed.startsWith('Edited 日本語Line 00'));
      // Save and reopen a long annotation; native focus reveals its final caret.
      await page.locator('.annotation-form').getByRole('button',{name:'Save',exact:true}).tap();
      await page.locator('.annotation-form').waitFor({state:'hidden'});
      await page.locator('[data-action="edit-draft-note"]').tap();
      await page.waitForFunction(()=>visualViewport.height<600);
      await page.waitForTimeout(700);
      const reopened=await measure('after-reopen');
      assert.ok(reopened.caretTop>=reopened.fieldTop && reopened.caretBottom<=reopened.fieldBottom+1);
      assert.equal(reopened.focused,true);
      await device.screenshot({path:join(root,'after-reopen.png')});
    }
    await page.getByRole('button',{name:'Close note',exact:true}).tap();
    await adbRun('shell','input','keyevent','4');
    await page.waitForTimeout(400);
  }
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));
  console.log('PASS Native Chrome keyboard, multiline editing and composition',root);
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));
  await context?.close();await device.close();
  await adbRun('reverse','--remove',`tcp:${port}`);
  server.kill('SIGTERM');await once(server,'exit');
}
