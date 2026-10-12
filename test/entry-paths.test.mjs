import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the entry hands commands a file path, not a URL pathname',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // A space is percent-encoded in a URL pathname; on Windows the pathname also starts with /C:/.
 const bin=join(await realpath(dir),'with space','bin');await mkdir(bin,{recursive:true});
 await copyFile(new URL('../bin/chill-entry.mjs',import.meta.url),join(bin,'chill-entry.mjs'));
 await writeFile(join(bin,'chill-help.mjs'),'console.log(process.argv[1]);\n');
 assert.equal(execFileSync(process.execPath,[join(bin,'chill-entry.mjs'),'help'],{encoding:'utf8'}).trim(),join(bin,'chill-help.mjs'));
});
