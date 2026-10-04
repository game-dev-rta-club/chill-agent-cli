import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {reviewGoals,renderGoalReview} from '../lib/goal-review.mjs';
const exec=promisify(execFile);
const g=(id,state='idle',children=[],extra={})=>({id,title:`Goal ${id}`,state,progress:state==='done'?100:0,letters:[],children,...extra});
test('filtered pages retain ancestor context and find deep matches without duplicate Letter counts',()=>{
 const tree=[g('1','working',[g('2','waiting',[g('3','idle',[],{letters:[{id:10}]})]),g('4','done'),g('5','idle')])];
 const first=reviewGoals(tree,{state:'open',limit:1});
 assert.equal(first.summary.letters,1);assert.equal(first.matched,2);assert.equal(first.returned,1);assert.equal(first.next,'3');
 assert.deepEqual(first.rows.map(r=>[r.goal.id,r.context]),[['1',true],['2',true],['3',false]]);
 const text=renderGoalReview(first);assert.match(text,/    #3 \[Open · 0%\]/);assert.match(text,/--state open --limit 1 --after 3/);assert.doesNotMatch(text,/#1\/#2|children/);
 const next=reviewGoals(tree,{state:'open',after:'3',limit:1});assert.deepEqual(next.rows.map(r=>r.goal.id),['1','5']);assert.equal(next.next,null);
 assert.deepEqual(reviewGoals(tree,{letters:true}).rows.filter(r=>!r.context).map(r=>r.goal.id),['3']);
 assert.equal(reviewGoals(tree,{state:'unfinished'}).matched,4);
 // A Goal changing state does not invalidate its position as a pagination cursor.
 tree[0].children[0].children[0].state='done';assert.equal(reviewGoals(tree,{state:'open',after:'3'}).returned,1);
 for(const options of [{state:'typo'},{limit:0},{limit:201},{after:'99'}])assert.throws(()=>reviewGoals(tree,options));
});
test('empty filters point to remaining states; Done is not inferred from no Letters',()=>{
 const waiting=renderGoalReview(reviewGoals([g('1','waiting')],{state:'open'}));
 assert.match(waiting,/No open Goals/);assert.match(waiting,/1 Waiting/);assert.match(waiting,/--state waiting/);
 const done=renderGoalReview(reviewGoals([g('1','done')],{state:'unfinished'}));
 assert.match(done,/No unfinished Goals/);assert.match(done,/All: chill goal review --id 1/);
});
test('review CLI returns an index, not Brief or conversation bodies, with functional filters',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={...process.env,CHILL_AGENT_DATA_DIR:dir,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
 const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
 const run=async(...args)=>(await exec(process.execPath,[cli,...args],{env})).stdout;
 const root=JSON.parse(await run('create','--title','Root'));
 const child=JSON.parse(await run('create','--title','Child','--parent',root.id));
 const leaf=JSON.parse(await run('create','--title','Leaf','--parent',child.id));
 await run('create','--title','Unrelated');
 const brief=JSON.parse(await run('brief','path','--id',leaf.id));
 await writeFile(brief.path,'Unique leaf Brief');await run('brief','update','--id',leaf.id);
 await run('letter','--id',child.id,'--title','Question title','--text','Question detail');
 const patch=join(dir,'patch.json');await writeFile(patch,JSON.stringify({state:'done'}));await run('update','--id',leaf.id,'--input-file',patch);
 const text=await run('review','--id',root.id);
 assert.deepEqual([...text.matchAll(/^\s*#(\d+) \[/gm)].map(m=>m[1]),[root.id,child.id,leaf.id]);
 assert.doesNotMatch(text,/Unique leaf Brief|Question detail|Unrelated/);assert.match(text,/1 Letter/);
 assert.doesNotMatch(await run('review','--id',root.id,'--state','unfinished'),/Leaf/);
 assert.match(await run('show','--id',leaf.id,'--format','text'),/Unique leaf Brief/);
 assert.match(await run('show','--id',child.id,'--format','text','--section','letters'),/Question detail/);
 await assert.rejects(run('review','--id',root.id,'--state','oops'));
});

test('show CLI defaults to five messages only in ordinary text browsing; since and JSON retain all',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-show-pages-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={...process.env,CHILL_AGENT_DATA_DIR:dir,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
 const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
 const run=async(...args)=>(await exec(process.execPath,[cli,...args],{env})).stdout;
 await run('create','--title','Root');
 for(let i=0;i<8;i++)await run('comment','--id','1','--text',`Item ${i}`);
 assert.equal((await run('show','--id','1','--format','text')).match(/^#\d+ agent/gm).length,5);
 assert.equal((await run('show','--id','1','--format','text','--since','0')).match(/^#\d+ agent/gm).length,8);
 assert.equal((await run('show','--id','1','--format','text','--full')).match(/^#\d+ agent/gm).length,8);
 assert.equal(JSON.parse(await run('show','--id','1')).conversation.length,8);
 const older=await run('show','--id','1','--format','text','--section','conversation','--before','4','--limit','5');
 assert.equal(older.match(/^#\d+ agent/gm).length,3);assert.doesNotMatch(older,/Brief/);
});
