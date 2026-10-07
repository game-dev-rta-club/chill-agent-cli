import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { commands } from '../lib/cli-help.mjs';
import { prepareRuntime } from '../lib/runtime-package.mjs';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url).pathname;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chill-help-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const data = join(directory, 'not initialized');
  const env = {...process.env, CHILL_AGENT_DATA_DIR:data, CHILL_AGENT_CODEX_PATH:'/missing/codex',
    CHILL_AGENT_CLOUDFLARED_PATH:'/missing/cloudflared', PORT:'not-a-port', CHILL_AGENT_IDLE_TIMEOUT:'invalid'};
  const run = (entry,args=[]) => execute(process.execPath,[entry,...args],{cwd:directory,env,timeout:5000});
  return {directory,data,env,run};
}

test('every command help works without data, valid settings, Codex, or server startup', async t => {
  const f=await fixture(t);
  const entries={monitor:'bin/chill-monitor.mjs',goal:'bin/chill-agent.mjs',settings:'bin/chill-settings.mjs',setup:'bin/chill-setup.mjs',
    server:'bin/chill-server.mjs',hook:'bin/chill-hook.mjs',connection:'bin/chill-connection.mjs',foreground:'server.mjs',link:'bin/chill-link.mjs'};
  for(const path of Object.keys(commands)) {
    if(!path)continue;
    const [group,...parts]=path.split(' ');
    const {stdout,stderr}=await f.run(join(root,entries[group]),[...parts,'--help']);
    assert.match(stdout,/Usage:/,path); assert.equal(stderr,'',path);
    assert.ok(stdout.includes(commands[path].summary),path);
  }
  assert.match((await f.run(join(root,entries.goal),['help','brief','update'])).stdout,/Markdown/);
  assert.match((await f.run(join(root,entries.setup),['-h'])).stdout,/prepare/);
  assert.match((await f.run(join(root,entries.link),['settings','remote','--help'])).stdout,/accessAud/);
  assert.deepEqual(await readdir(f.directory),[], 'help must not migrate/create store, install a hook, or write runtime files');
  await assert.rejects(f.run(join(root,entries.goal),['unknown','--help']),/Unknown command/);
});

test('invalid option contracts fail before initializing the store or saving settings',async t=>{
  const f=await fixture(t);
  for(const args of [
    ['create','--title','x','--title','y'], ['create','--unknown','x'], ['note','--id','1'],
    ['note','--id','1','--title','Delivery','--type','report'], ['comment','--id','1','--text','hello','--text-file','x'],
  ]) await assert.rejects(f.run(join(root,'bin/chill-agent.mjs'),args));
  for(const args of [
    ['notifications','--off','--file','x'],['remote','--off','--off'],
    ['notice','--id','1','--version','1','--when','unknown'],['show','--file','x'],
  ])await assert.rejects(f.run(join(root,'bin/chill-settings.mjs'),args));
  await assert.rejects(f.run(join(root,'bin/chill-setup.mjs'),['prepare','--project','--helpful']));
  assert.deepEqual(await readdir(f.directory),[]);
});

test('help-guided operations work and settings flags are order independent',async t=>{
  const f=await fixture(t);
  f.env.CHILL_AGENT_CODEX_PATH=join(root,'test/fake-codex.mjs');
  f.env.PORT='4173'; delete f.env.CHILL_AGENT_IDLE_TIMEOUT;
  const plan=args=>f.run(join(root,'bin/chill-agent.mjs'),args);
  const created=await plan(['create','--title','Help-guided Plan']);
  assert.match(created.stdout,/"id": "1"/);
  const body=join(f.data,'workspace/goals/1/brief.md'); await writeFile(body,'A clear goal');
  await plan(['brief','update','--id','1']);
  await plan(['comment','--id','1','--text','We can proceed.']);
  assert.match((await plan(['show','--id','1'])).stdout,/A clear goal[\s\S]*We can proceed/);
  await writeFile(body,'A clear goal, updated');
  await plan(['brief','update','--id','1']);
  await plan(['comment','--id','1','--text','Historical']);
  const settings=args=>f.run(join(root,'bin/chill-settings.mjs'),args);
  assert.deepEqual(JSON.parse((await settings(['notice','--event','2','--id','1'])).stdout),{enabled:false});
  const config=join(f.directory,'notification.json');
  await writeFile(config,JSON.stringify({enabled:true,tool:'test-tool',destination:'chosen-user',on:['comment']}));
  await settings(['notifications','--file',config]);
  const notice=JSON.parse((await settings(['notice','--event','2','--id','1'])).stdout);
  assert.equal(notice.destination,'chosen-user'); assert.equal(notice.url,null);
  assert.match(await readFile(join(f.data,'settings/notifications.json'),'utf8'),/chosen-user/);
});
