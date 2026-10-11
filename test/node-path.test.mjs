import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {stableNodePath} from '../lib/node-path.mjs';
import {prepareRuntime} from '../lib/runtime-package.mjs';

async function temporary(t){const dir=await mkdtemp(join(tmpdir(),'node-path-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('a Homebrew Cellar Node is persisted through its stable opt link',async t=>{
 const dir=await temporary(t),bin=join(dir,'Cellar/node/25.6.1/bin');await mkdir(bin,{recursive:true});
 const node=join(bin,'node');await writeFile(node,'');
 await mkdir(join(dir,'opt'));await symlink('../Cellar/node/25.6.1',join(dir,'opt/node'));
 assert.equal(stableNodePath(node),join(dir,'opt/node/bin/node'));
 // An opt link to another version is not the running binary.
 const other=join(dir,'Cellar/node/24.0.0/bin');await mkdir(other,{recursive:true});await writeFile(join(other,'node'),'');
 assert.equal(stableNodePath(join(other,'node')),join(other,'node'));
 assert.equal(stableNodePath('/usr/local/bin/node'),'/usr/local/bin/node');
});

test('the short chill entry runs the launcher and falls back to Node on PATH',async t=>{
 const dir=await temporary(t),root=fileURLToPath(new URL('../',import.meta.url));
 const prepared=await prepareRuntime(root,join(dir,"data ' store"));
 assert.equal(prepared.entry,join(prepared.dataDirectory,'runtime/chill'));
 const env={...process.env,PATH:`${dirname(process.execPath)}:/usr/bin:/bin`};delete env.CHILL_AGENT_DATA_DIR;
 assert.match(execFileSync(prepared.entry,['connection','--help'],{env,encoding:'utf8'}),/Wait in the background/);
 // Simulate an upgrade that removed the recorded binary.
 const script=await readFile(prepared.entry,'utf8');
 await writeFile(prepared.entry,script.replace(/^node=.*$/m,"node='/missing/bin/node'"),{mode:0o700});
 assert.match(execFileSync(prepared.entry,['connection','--help'],{env,encoding:'utf8'}),/Wait in the background/);
});
