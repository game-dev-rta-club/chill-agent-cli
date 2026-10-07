import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,cp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {agentGuide} from '../lib/agent-guidance.mjs';

test('optional application guidance resolves inside each copy of the runtime',async t=>{
 const base=await mkdtemp(join(tmpdir(),'chill-guide-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const source=join(base,'source'),copy=join(base,'copy');
 await mkdir(source);
 const manifest=pathToFileURL(join(source,'extensions.json'));
 assert.equal(agentGuide(manifest),null,'standalone CLI needs no application skill');
 await writeFile(manifest,JSON.stringify({modules:[]}));
 assert.equal(agentGuide(manifest),null);
 await mkdir(join(source,'skills/example/references/work'),{recursive:true});
 await writeFile(join(source,'skills/example/SKILL.md'),'[Resume](references/work/resume.md)');
 await writeFile(join(source,'skills/example/references/work/resume.md'),'Resume agreed work.');
 await writeFile(manifest,JSON.stringify({agentGuide:'skills/example/SKILL.md'}));
 await cp(source,copy,{recursive:true});
 await rm(source,{recursive:true});
 const entry=agentGuide(pathToFileURL(join(copy,'extensions.json')));
 assert.equal(entry,join(copy,'skills/example/SKILL.md'));
 assert.match(await readFile(entry,'utf8'),/references\/work\/resume.md/);
 assert.equal(await readFile(join(copy,'skills/example/references/work/resume.md'),'utf8'),'Resume agreed work.');
});

test('guide configuration cannot silently resolve outside its packaged runtime',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-guide-invalid-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const manifest=pathToFileURL(join(root,'extensions.json'));
 for(const agentGuidePath of ['../outside.md','/absolute.md','bad\nname.md','file.js',true]){
  await writeFile(manifest,JSON.stringify({agentGuide:agentGuidePath}));
  assert.throws(()=>agentGuide(manifest));
 }
});
