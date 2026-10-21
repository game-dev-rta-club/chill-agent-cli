import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudflaredPath,publicLinkOn} from '../lib/tunnel.mjs';

const finder=installed=>{const tried=[];return {tried,exists:async path=>{tried.push(path);if(!installed.includes(path))throw Error('missing');}};};

test('Windows finds cloudflared.exe on PATH, then where winget and the MSI put it',async()=>{
 const env={Path:'C:\\Windows\\system32;C:\\Tools',LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local','ProgramFiles(x86)':'C:\\Program Files (x86)',ProgramFiles:'C:\\Program Files'};
 const onPath=finder(['C:\\Tools\\cloudflared.exe']);
 assert.equal(await cloudflaredPath(env,{platform:'win32',exists:onPath.exists}),'C:\\Tools\\cloudflared.exe');
 // Web started by Task Scheduler before the install keeps its old PATH.
 const winget=finder(['C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe']);
 assert.equal(await cloudflaredPath(env,{platform:'win32',exists:winget.exists}),'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe');
 assert.deepEqual(winget.tried,['C:\\Windows\\system32\\cloudflared.exe','C:\\Tools\\cloudflared.exe','C:\\Program Files (x86)\\cloudflared\\cloudflared.exe','C:\\Program Files\\cloudflared\\cloudflared.exe','C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe']);
 await assert.rejects(cloudflaredPath(env,{platform:'win32',exists:finder([]).exists}),/winget install --id Cloudflare\.cloudflared/);
});

test('macOS keeps its PATH and Homebrew lookup, and an explicit path wins',async()=>{
 const mac=finder(['/opt/homebrew/bin/cloudflared']);
 assert.equal(await cloudflaredPath({PATH:'/usr/bin:/bin'},{platform:'darwin',exists:mac.exists}),'/opt/homebrew/bin/cloudflared');
 assert.deepEqual(mac.tried,['/usr/bin/cloudflared','/bin/cloudflared','/opt/homebrew/bin/cloudflared']);
 await assert.rejects(cloudflaredPath({PATH:''},{platform:'darwin',exists:finder([]).exists}),/brew install cloudflared/);
 assert.equal(await cloudflaredPath({CHILL_AGENT_CLOUDFLARED_PATH:'D:\\cf.exe',Path:'C:\\Tools'},{platform:'win32',exists:finder(['D:\\cf.exe']).exists}),'D:\\cf.exe');
});

test('a configured start follows the panel\'s saved On/Off',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'chill-link-state-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 assert.equal(await publicLinkOn(directory),true,'a saved connection without a panel choice starts On');
 await mkdir(join(directory,'workspace','public-link'),{recursive:true});
 await writeFile(join(directory,'workspace','public-link','1.json'),JSON.stringify({enabled:false,confirmedPublic:true}));
 assert.equal(await publicLinkOn(directory),false);
 await writeFile(join(directory,'workspace','public-link','1.json'),JSON.stringify({enabled:true,confirmedPublic:true}));
 assert.equal(await publicLinkOn(directory),true);
});
