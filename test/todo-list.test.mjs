import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeMessagesSince} from '../lib/claude-transcript.mjs';
import {shownTodo} from '../lib/todo-list.mjs';
import {todoMarkup,showsThink} from '../public/work-ui.js';
import {claudeEntry,claudeLines} from './claude-fixtures.mjs';

const plan='mcp__ccd_turn__update_plan';
let n=0;
// One tool call and its result, a second apart.
function call(name,input,{result='ok',error=false,toolUseResult,at,sidechain=false}={}){
 const id=`c${++n}`,time=Date.parse(at||'2026-11-14T08:00:00.000Z')+n*1000,patch={timestamp:new Date(time).toISOString(),...(sidechain?{isSidechain:true}:{})};
 return [claudeEntry.tool(id,name,input,patch),claudeEntry.toolResult(`r${id}`,`toolu_${id}`,result,{...patch,...(toolUseResult?{toolUseResult}:{}),message:{content:[{type:'tool_result',tool_use_id:`toolu_${id}`,content:result,...(error?{is_error:true}:{})}]}})];
}
async function transcript(t,entries){
 const dir=await mkdtemp(join(tmpdir(),'chill-todo-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const path=join(dir,'session.jsonl');await writeFile(path,claudeLines(entries.flat()));
 return {path,todo:async(since='2026-11-14T07:00:00.000Z')=>(await claudeMessagesSince(path,since)).todo,add:more=>appendFile(path,claudeLines(more.flat()))};
}
const items=list=>list?.items.map(item=>`${item.status} ${item.text}`);

test('Claude Desktop update_plan: the whole list, advance, and steps by number',async t=>{
 const {todo,add}=await transcript(t,[call(plan,{items:[{content:'Read',status:'in_progress'},{content:'Build',status:'pending'},{content:'Test',status:'pending'}],scope:'first_task'})]);
 assert.deepEqual(items(await todo()),['active Read','pending Build','pending Test']);
 await add([call(plan,{advance:true})]);
 assert.deepEqual(items(await todo()),['done Read','active Build','pending Test']);
 await add([call(plan,{done:[2],start:3})]);
 assert.deepEqual(items(await todo()),['done Read','done Build','active Test']);
 await add([call(plan,{advance:true})]);
 assert.deepEqual(items(await todo()),['done Read','done Build','done Test'],'advance after the last step completes it');
});

test('a refused call and a subagent list change nothing',async t=>{
 const {todo}=await transcript(t,[
  call(plan,{items:[{content:'Mine',status:'in_progress'}],scope:'first_task'}),
  call(plan,{items:[{content:'Refused',status:'pending'}]},{result:'scope is required',error:true}),
  call(plan,{items:[{content:'Subagent',status:'pending'}],scope:'first_task'},{sidechain:true}),
  call('TodoWrite',{todos:'[{"content":"Off","status":"pending"}]'},{result:'TodoWrite is disabled for this session',error:true}),
 ]);
 assert.deepEqual(items(await todo()),['active Mine']);
});

test('Claude Code TaskCreate and TaskUpdate, and the older TodoWrite',async t=>{
 const {todo,add}=await transcript(t,[
  call('TaskCreate',{subject:'alpha',description:'a'},{result:'Task #1 created successfully: alpha',toolUseResult:{task:{id:'1',subject:'alpha'}}}),
  call('TaskCreate',{subject:'beta',description:'b'},{result:'Task #2 created successfully: beta'}),
  call('TaskUpdate',{taskId:'1',status:'in_progress'}),
 ]);
 assert.deepEqual(items(await todo()),['active alpha','pending beta'],'the id comes from the result, or its text');
 await add([call('TaskUpdate',{taskId:'1',status:'completed'}),call('TaskUpdate',{taskId:'2',status:'deleted'})]);
 assert.deepEqual(items(await todo()),['done alpha']);
 await add([call('TodoWrite',{todos:[{content:'one',status:'completed',activeForm:'Doing one'},{content:'two',status:'in_progress',activeForm:'Doing two'}]})]);
 assert.deepEqual(items(await todo()),['done one','active two'],'TodoWrite sends the whole list');
});

test('a list finished before the current work started is not shown',()=>{
 const at=Date.parse('2026-11-14T08:00:00.000Z'),done={items:[{text:'a',status:'done'}],at},open={items:[{text:'a',status:'active'}],at};
 assert.equal(shownTodo(done,'2026-11-14T09:00:00.000Z'),null);
 assert.equal(shownTodo(done,'2026-11-14T07:00:00.000Z'),done,'finished during this work, it stays');
 assert.equal(shownTodo(open,'2026-11-14T09:00:00.000Z'),open,'an open list stays across wakes');
});

test('Think shows the todo list under its text, each item marked',()=>{
 const todo={items:[{text:'Read <code>',status:'done'},{text:'Build',status:'active'},{text:'Test',status:'pending'}],at:1};
 const html=todoMarkup(todo);
 assert.match(html,/Todo 1\/3/);
 assert.match(html,/data-status="done"><span class="work-todo-mark" aria-hidden="true">✓<\/span><span>Read &lt;code&gt;/);
 assert.match(html,/data-status="active"><span class="work-todo-mark" aria-hidden="true">●/);
 assert.equal(todoMarkup(null),'');
 assert.equal(showsThink({messages:[],todo},false),true,'an ended work with only a list still has Think to show');
});
