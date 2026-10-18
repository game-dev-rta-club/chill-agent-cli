import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';

const publicDir=new URL('../public/',import.meta.url);
const read=async ext=>(await Promise.all((await readdir(publicDir)).filter(f=>f.endsWith(ext)).map(f=>readFile(new URL(f,publicDir),'utf8')))).join('\n');
// Classes the scripts only look up; nothing styles them.
const hooksOnly=new Set(['agent-extensions','comment','activity-event','note-delete','note-comment','pending','goal-children']);

test('every class the Web writes into its pages has a style, so removing a rule cannot silently break a screen',async()=>{
  const [scripts,styles]=await Promise.all([read('.js'),read('.css')]);
  const written=new Set([...scripts.matchAll(/class="([^"$]*)"/g)].flatMap(m=>m[1].split(/\s+/)).filter(Boolean));
  const unstyled=[...written].filter(name=>!hooksOnly.has(name)&&!new RegExp(`\\.${name}(?![\\w-])`).test(styles));
  assert.deepEqual(unstyled,[]);
});
