import assert from 'node:assert/strict';
import test from 'node:test';
import {goalPage} from '../lib/workspace-reader.mjs';
import {renderGoalPage} from '../lib/goal-page-text.mjs';
import {createGoalView} from '../public/goal-view.js';
import {notificationText} from '../lib/delivery.mjs';
const goal=(id,parentId,extra={})=>({id,parentId,title:`Goal ${id}`,scope:`Scope ${id}`,criteria:`Outcome ${id}`,state:'idle',briefs:[],conversation:[],briefPath:`/goals/${id}/brief.md`,...extra});
const brief=(goalId,version)=>({goalId,version,body:`# Brief ${version}`});
const letter=(id,goalId)=>({id,changeId:id,goalId,type:'letter',author:'agent',title:`Question ${id}`,text:`Question body ${id}`,updatedAt:'2026-09-30T00:00:00Z'});
test('historical Brief keeps the current tree and whole Goal conversation',()=>{
 const goals=[goal('1',null),goal('2','1',{briefs:[brief('2',1),brief('2',2)],conversation:[letter(1,'2'),{id:2,changeId:2,goalId:'2',author:'user',type:'comment',text:'',annotations:[{kind:'letter',source:{kind:'comment',eventId:1},text:'Answer'}]}]}),goal('3','2',{state:'done'}),goal('4','2',{conversation:[letter(3,'4')],state:'waiting',waitReason:'Source'})];
 const page=goalPage(goals,'2',{version:1,since:1});
 assert.equal(page.goal.progress,50);assert.equal(page.goal.state,'waiting');assert.equal(page.brief.version,1);
 assert.deepEqual(page.conversation.map(e=>e.id),[2]);assert.equal(page.answerTargets[0].text,'Question body 1');
 assert.deepEqual(page.letters.map(l=>l.id),[3]);assert.match(page.letters[0].url,/#\/goal\/4\/letter\/3$/);
 assert.equal(page.latestVersion,2);assert.equal(page.root.scope,'Scope 1');
 const web=Object.fromEntries(goals.map(g=>[g.id,{...g,children:goals.filter(c=>c.parentId===g.id).map(c=>c.id)}]));
 const view=createGoalView(web,'2',new Set());assert.equal(view.letterCount('2'),page.goal.letterCount);
 const text=renderGoalPage({...page,attachments:[]});assert.match(text,/Root agreement #1/);assert.match(text,/Brief · v1/);assert.match(text,/Answer target · Letter #1/);assert.match(text,/Answer to Letter #1:\nAnswer/);
 assert.match(text,/Editable Markdown: \/goals\/2\/brief.md/);
 assert.equal(goalPage(goals,'3').brief,null);
 for(const options of [{version:0},{version:99},{since:-1}])assert.throws(()=>goalPage(goals,'2',options));
});
test('feedback protocol addresses Goal conversation and answers without version targeting',()=>{
 const event={id:42,changeId:42,goalId:'2',author:'user',text:'Hello',annotations:[{kind:'letter',source:{kind:'comment',eventId:3},text:'A'}]},state={eventId:42,goalId:'2',messageId:'test'};
 const context={root:{id:'1'},path:[{title:'Root'},{title:'Child'}]};
 const text=notificationText(state,event,'Child','',context);
 assert.match(text,/Goal: #2 "Root" \/ "Child"\nFeedback: #42/);assert.doesNotMatch(text,/Note:|--version|reopen/);
 assert.match(text,/show --id 2 --since 41 --format text/);assert.match(text,/comment --id 2/);assert.match(text,/letter --id 2/);
 assert.equal(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]).messages[0].notes[0].source.eventId,3);
});

test('history pages preserve original Letter questions and offer older cursors',()=>{
 const events=[letter(1,'1'),...Array.from({length:7},(_,i)=>({id:i+2,changeId:i+2,goalId:'1',type:'comment',author:'user',text:`Message ${i+2}`}))];
 events.at(-1).annotations=[{kind:'letter',source:{eventId:1},text:'Answer to the older Letter'}];
 const goals=[goal('1',null,{conversation:events})];
 const page=goalPage(goals,'1',{limit:5});
 assert.deepEqual(page.conversation.map(e=>e.id),[4,5,6,7,8]);assert.equal(page.answerTargets[0].id,1);
 assert.equal(page.conversationInfo.remaining,3);assert.equal(page.conversationInfo.nextBefore,4);
 const text=renderGoalPage({...page,attachments:[]});assert.match(text,/--section conversation --before 4 --limit 5/);assert.match(text,/Question body 1/);
 const older=goalPage(goals,'1',{limit:5,before:4});assert.deepEqual(older.conversation.map(e=>e.id),[1,2,3]);assert.equal(older.conversationInfo.remaining,0);
 assert.equal(goalPage(goals,'1',{since:1}).conversation.length,7,'a since boundary without a limit keeps every new instruction');
 for(const options of [{before:-1},{before:1,since:1},{limit:0},{limit:101}])assert.throws(()=>goalPage(goals,'1',options));
});
test('Brief pages pin their version, keep full access and do not silently discard the remainder',()=>{
 const body='a'.repeat(6000)+'Last section';
 const page={...goalPage([goal('1',null,{briefs:[{goalId:'1',version:1,body,format:'markdown'}]})],'1'),attachments:[]};
 const text=renderGoalPage(page);assert.doesNotMatch(text,/Last section/);assert.match(text,/--version 1 --format text --section brief --brief-offset 6000/);
 const rest=renderGoalPage(page,{section:'brief',briefOffset:6000});assert.match(rest,/Last section/);assert.doesNotMatch(rest,/Conversation/);
 assert.match(renderGoalPage(page,{full:true}),/Last section/);
 assert.throws(()=>renderGoalPage(page,{briefOffset:999999}));
});
