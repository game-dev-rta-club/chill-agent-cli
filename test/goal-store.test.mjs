import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {writeFile,readFile} from './record-fixture.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
async function fixture(t,storage){
 const root=await mkdtemp(join(tmpdir(),'chill-goals-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const env={...process.env,...(storage?{CHILL_AGENT_STORAGE:storage}:{}),CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
 const invoke=(...args)=>execute(process.execPath,[cli,...args],{env});
 const run=async(...args)=>JSON.parse((await invoke(...args)).stdout);
 let serial=0;
 const update=async(id,patch)=>{const file=join(root,`patch-${serial++}.json`);await writeFile(file,JSON.stringify(patch));return run('update','--id',id,'--input-file',file);};
 const feedback=async(id,input)=>{const file=join(root,`feedback-${serial++}.json`);await writeFile(file,JSON.stringify(input));return (await invoke('feedback','--id',id,'--input-file',file)).stdout.trim().split('\n').map(JSON.parse)[0].feedback;};
 const brief=async(id,body)=>{const {path}=await run('deliverable','path','--id',id);await writeFile(path,body);return run('deliverable','update','--id',id);};
 // Letters saved by the removed goal letter command, such as its no-reply notices.
 const legacy=async input=>JSON.parse((await execute(process.execPath,['--input-type=module','-e',`import {appendAgentComment} from ${JSON.stringify(new URL('../lib/goal-store.mjs',import.meta.url).href)};console.log(JSON.stringify(await appendAgentComment(${JSON.stringify(input)})));`],{env})).stdout);
 return {root,run,invoke,update,feedback,brief,legacy};
}
test('empty Goals accept Conversation; stable Markdown updates only publish changes',async t=>{
 const f=await fixture(t),goal=await f.run('create','--title','Stable Goal');
 assert.equal(await readFile(goal.deliverablePath,'utf8'),'');
 assert.equal((await f.run('show','--id','1')).deliverable,null);
 await f.run('reply','--id','1','--text','Before Deliverable');
 const first=await f.brief('1','# Plan\n\nOriginal'),path=join(f.root,'workspace/goals/1/briefs/v1.json'),bytes=await readFile(path,'utf8');
 assert.equal(first.changed,true);
 await assert.rejects(f.invoke('deliverable','update','--id','1'),error=>/Not published: .*deliverable\.html is the same as v1\./.test(error.stderr)&&error.code===1,'an unchanged file fails so a failed edit is noticed');
 assert.equal((await f.run('show','--id','1')).deliverable.version,1);
 await writeFile(goal.deliverablePath,'# Plan\n\nEdited');
 assert.equal((await f.run('show','--id','1')).deliverable.body,'# Plan\n\nOriginal','unpublished edits stay local');
 await f.run('deliverable','update','--id','1');
 await f.run('reply','--id','1','--text','After update');
 const past=await f.run('show','--id','1','--version','1');
 assert.equal(past.goal.title,'Stable Goal');assert.equal(past.deliverable.body,first.body);
 assert.equal(past.conversation.length,2);assert.equal(past.latestVersion,2);
 assert.equal(await readFile(path,'utf8'),bytes);
});
test('publishing a Deliverable without layout succeeds with a one-line visual-first hint',async t=>{
 const f=await fixture(t);await f.run('create','--title','Visual Goal');
 const publish=async(body,format)=>{const {path}=await f.run('deliverable','path','--id','1','--format',format);await writeFile(path,body);return f.run('deliverable','update','--id','1','--format',format);};
 const markdown=await publish('# Plan\n\n- Step one\n- Step two','markdown');
 assert.equal(markdown.changed,true,'Markdown still publishes');assert.match(markdown.hint,/^This is Markdown\. Make it a visual-first HTML page: diagrams \(inline SVG\), tables, the current and finished form side by side\.$/);
 const plain=await publish('<h1>Plan</h1><ul><li>Step one</li></ul><style>p{color:red}</style>','html');
 assert.equal(plain.changed,true);assert.match(plain.hint,/^This reads like Markdown in HTML\. Make it a visual-first page: /);assert.doesNotMatch(plain.hint,/\n/);
 for(const body of ['<table><tr><td>Now</td><td>Finished</td></tr></table>','<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
   '<img src="/api/images/00000000-0000-0000-0000-000000000000" alt="Mockup">','<style>.pair{display: grid}</style><div class="pair"><p>Now</p><p>Finished</p></div>',
   '<div style="display:inline-flex"><p>Now</p><p>Finished</p></div>'])
  assert.equal((await publish(body,'html')).hint,undefined,body);
 assert.equal((await publish('','html')).hint,undefined,'clearing the Deliverable needs no hint');
});
test('a Letter is a reply with --ask; the old comment, letter and assign commands are gone',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');
 await assert.rejects(f.invoke('letter','--id','1','--title','Which way?','--text','A question'),error=>/Unknown command: goal letter/.test(error.stderr));
 await assert.rejects(f.run('reply','--id','1','--title','title','--text','x'),/Unknown option/);
 await assert.rejects(f.run('reply','--id','1','--ask',' ','--text','x'),/Letter title must be nonempty/);
 await assert.rejects(f.run('reply','--id','1','--ask','Which\nway?','--text','x'),/one line/);
 for(const command of ['note','comment','assign','reopen'])await assert.rejects(f.run(command,'--id','1'),/Unknown command/);
 const letter=await f.run('reply','--id','1','--ask','Which way?','--text','Would you prefer A or B?');
 assert.equal(letter.type,'letter');assert.equal(letter.title,'Which way?');assert.match(letter.url,new RegExp(`/goal/1/letter/${letter.id}$`));
 const plain=await f.run('reply','--id','1','--text','Progress');assert.equal(plain.type,'comment');assert.equal(plain.title,undefined);assert.doesNotMatch(plain.url,/letter/);
 const page=await f.run('show','--id','1');assert.deepEqual(page.letters.map(l=>l.id),[letter.id]);assert.equal(page.deliverable,null);
 assert.equal(page.conversation[0].type,'letter');assert.equal(page.conversation[0].version,undefined);
 assert.equal((await f.run('tree'))[0].letterCount,1);
});
for(const storage of ['json','sqlite'])test(`${storage}: a user comment on the Goal closes its open Letters, whatever it says; nothing else does`,async t=>{
 const {unanswered}=await import('../lib/agent-rules.mjs');
 const f=await fixture(t,storage);await f.run('create','--title','Root');await f.run('create','--title','Child','--parent','1');
 const a=await f.run('reply','--id','1','--ask','A','--text','A?'),b=await f.run('reply','--id','1','--ask','B','--text','B?');
 const child=await f.run('reply','--id','2','--ask','Child','--text','Child?');
 await f.brief('1','Plan');await f.run('reply','--id','1','--text','Progress');
 assert.equal((await f.run('tree'))[0].letterCount,3,'Deliverable updates and agent Comments leave Letters open');
 const answer=await f.feedback('1',{text:'About something else',requestId:'answer-request-01'});
 let page=await f.run('show','--id','1');
 assert.deepEqual(page.letters.map(l=>l.id),[child.id],'it closes its own Goal\'s Letters, not a Split Goal\'s');
 for(const letter of [a,b]){const closed=page.conversation.find(e=>e.id===letter.id);assert.equal(closed.answeredBy,answer.id);assert.equal(closed.receivedAt,answer.updatedAt);assert.ok(closed.changeId>answer.id);}
 assert.deepEqual(unanswered(page.conversation).map(e=>e.id),[answer.id],'closing the Letters does not reply to the comment');
 assert.equal((await f.feedback('1',{text:'About something else',requestId:'answer-request-01'})).id,answer.id,'a retried comment is saved once');
 const delta=await f.run('show','--id','1','--since',String(answer.id));assert.deepEqual(delta.conversation.map(e=>e.id).sort(),[a.id,b.id].sort(),'readers learn of the closed Letters');
 const followup=await f.run('reply','--id','1','--ask','One more','--text','Another choice?');
 assert.deepEqual((await f.run('show','--id','1')).letters.map(l=>l.id),[followup.id,child.id],'a comment before a Letter does not close it');
 const annotated=await f.feedback('1',{annotations:[{kind:'text',source:{kind:'comment',eventId:followup.id},anchor:{start:0,end:7,quote:'Another'},text:'A note about the wording'}]});
 assert.equal((await f.run('show','--id','1')).conversation.find(e=>e.id===followup.id).answeredBy,annotated.id,'an annotation on the Letter is a comment on its Goal');
 const last=await f.run('reply','--id','1','--ask','Last','--text','Last choice?');
 const reply=await f.feedback('1',{text:'Last answer',annotations:[{kind:'letter',source:{kind:'comment',eventId:last.id},text:'This one'}]});
 page=await f.run('show','--id','1');assert.equal(page.conversation.find(e=>e.id===last.id).answeredBy,reply.id);
 assert.equal((await f.run('tree'))[0].letterCount,1);
 await f.feedback('2',{text:'Child answer'});assert.equal((await f.run('tree'))[0].letterCount,0);
 await f.run('create','--title','Other');
 await assert.rejects(f.feedback('3',{annotations:[{kind:'letter',source:{kind:'comment',eventId:a.id},text:'Foreign'}]}),/Letter not found/);
 await assert.rejects(f.feedback('1',{annotations:[{kind:'letter',source:{kind:'comment',eventId:a.id},text:'One'},{kind:'letter',source:{kind:'comment',eventId:a.id},text:'Two'}]}),/once per comment/);
 await assert.rejects(f.feedback('1',{answers:[{letterId:a.id,text:'Old format'}]}),/Unknown Conversation field/);
 await assert.rejects(f.feedback('1',{annotations:[{kind:'letter',source:{kind:'brief',eventId:a.id},text:'Wrong source'}]}),/Agent Letter/);
 const normal=await f.run('reply','--id','1','--text','Ordinary message');
 await assert.rejects(f.feedback('1',{annotations:[{kind:'letter',source:{kind:'comment',eventId:normal.id},text:'Not a Letter'}]}),/Letter not found/);
});
test('parent edits reject missing parents and cycles, including simultaneous reparenting',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');await f.run('create','--title','Child','--parent','1');
 await assert.rejects(f.run('create','--title','Missing','--parent','9'),/Parent Goal not found/);
 await assert.rejects(f.update('1',{parentId:'2'}),/own ancestor/);
 await f.run('create','--title','Other');
 const outcomes=await Promise.allSettled([f.update('1',{parentId:'3'}),f.update('3',{parentId:'1'})]);
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
});
test('Letter titles accept exact text annotations with a distinct source field',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');await f.run('create','--title','Other');
 const letter=await f.run('reply','--id','1','--ask','Title question','--text','Message question');
 const note={kind:'text',source:{kind:'comment',eventId:letter.id,field:'title'},anchor:{start:0,end:5,quote:'Title'},text:'About the title'};
 const saved=await f.feedback('1',{annotations:[note]});
 assert.deepEqual(saved.annotations[0].source,note.source);
 assert.equal((await f.run('show','--id','1')).letters.length,0,'a title annotation is a comment on the Goal, so it answers the Letter');
 assert.match((await f.invoke('show','--id','1','--format','text')).stdout,/Annotation · Letter title/);
 const ordinary=await f.run('reply','--id','1','--text','Title question');
 for(const source of [{...note.source,eventId:ordinary.id},{...note.source,field:'other'}])
  await assert.rejects(f.feedback('1',{annotations:[{...note,source}]}),/Annotation/);
 await assert.rejects(f.feedback('2',{annotations:[note]}),/Annotation/);
 await assert.rejects(f.feedback('1',{annotations:[{...note,anchor:{start:0,end:7,quote:'Message'}}]}),/Annotation/);
 await assert.rejects(f.feedback('1',{annotations:[{...note,source:{kind:'comment',eventId:letter.id}}]}),/Annotation/);
 await f.feedback('1',{annotations:[note]});
 assert.equal((await f.run('show','--id','1')).letters.length,0,'a closed Letter title still takes annotations');
});
test('the agent withdraws a Letter no longer needed; the Letter stays, and counts and cursors update without a user answer',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');await f.run('create','--title','Child','--parent','1');
 await f.update('2',{state:'waiting',waitReason:'Independent prerequisite'});
 const a=await f.run('reply','--id','1','--ask','Choice','--text','Which option?');
 const child=await f.run('reply','--id','2','--ask','Child choice','--text','Which child option?');
 const comment=await f.run('reply','--id','1','--text','The choice is settled in this discussion.');
 assert.equal((await f.run('tree'))[0].letterCount,2);
 for(const id of ['0','1.5','9007199254740992'])await assert.rejects(f.run('close-letter','--id','1','--event',id),/positive integer/);
 await assert.rejects(f.run('close-letter','--id','1','--event',String(child.id)),/Letter not found/);
 await assert.rejects(f.run('close-letter','--id','1','--event',String(comment.id)),/Letter not found/);
 await assert.rejects(f.run('close-letter','--id','1','--event',String(a.id),'--answer',String(comment.id)),/Unknown option/);
 const results=await Promise.all(Array.from({length:4},()=>f.run('close-letter','--id','1','--event',String(a.id),'--reason','No further answer or visibility is needed.')));
 assert.equal(results.filter(r=>r.changed).length,1);assert.ok(results.every(r=>r.status==='received'));
 const received=results.find(r=>r.changed);assert.equal(received.id,a.id);assert.equal(received.updatedAt,a.updatedAt);assert.equal(received.text,a.text);assert.equal(received.changeId,comment.id+1);
 let page=await f.run('show','--id','1','--since',String(comment.id));
 assert.deepEqual(page.conversation.map(e=>e.id),[a.id]);assert.equal(page.conversationInfo.cursor,received.changeId);
 assert.deepEqual(page.letters.map(l=>l.id),[child.id]);assert.equal(page.conversation[0].receiveReason,'No further answer or visibility is needed.');
 assert.equal((await f.run('tree'))[0].children[0].state,'waiting');
 assert.equal((await f.run('check','--since',String(comment.id))).count,0);
 const next=await f.run('reply','--id','1','--text','Receipt recorded.');assert.equal(next.id,received.changeId+1);
 const annotation={kind:'text',source:{kind:'comment',eventId:a.id},anchor:{start:0,end:5,quote:'Which'},text:'Still the same question'};
 await f.feedback('1',{annotations:[annotation]});
 page=await f.run('show','--id','1');assert.equal(page.conversation.filter(e=>e.id===a.id).length,1);
 assert.equal(page.conversation.filter(e=>e.author==='user').length,1,'receipt does not fabricate an answer');
 const withdrawn=page.conversation.find(e=>e.id===a.id);assert.equal(withdrawn.receivedAt,received.receivedAt);assert.equal(withdrawn.answeredBy,undefined,'a later comment leaves a withdrawn Letter as it was');
 const answer=await f.feedback('2',{annotations:[{kind:'letter',source:{kind:'comment',eventId:child.id},text:'Explicit answer'}]});
 const answered=await f.run('close-letter','--id','2','--event',String(child.id));
 assert.equal(answered.changed,false);assert.equal(answered.status,'answered');assert.equal(answered.answeredBy,answer.id);
 assert.equal((await f.run('tree'))[0].letterCount,0);
});
test('concurrent Goal creation and identical Deliverable updates allocate without duplicates',async t=>{
 const f=await fixture(t);const goals=await Promise.all(Array.from({length:4},()=>f.run('create','--title','Goal')));
 assert.deepEqual(goals.map(g=>g.id).sort(),['1','2','3','4']);
 await writeFile(goals.find(g=>g.id==='1').deliverablePath,'# Current');
 const saved=await Promise.allSettled(Array.from({length:4},()=>f.run('deliverable','update','--id','1')));
 assert.equal(saved.filter(s=>s.status==='fulfilled'&&s.value.changed&&s.value.version===1).length,1);
 assert.ok(saved.filter(s=>s.status==='rejected').every(s=>/Not published: .* is the same as v1\./.test(s.reason.stderr)));
 assert.equal((await f.run('show','--id','1')).deliverable.version,1);
 await assert.rejects(f.update('1',{state:'working'}),/Live Working/);
 await assert.rejects(f.update('1',{state:'waiting'}),/Waiting reason/);
});
test('completed leaf count is independent of Deliverable, comments and Letter answers',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');
 for(const title of ['Done','Started','Waiting'])await f.run('create','--title',title,'--parent','1');
 await f.update('2',{state:'done'});await f.update('3',{started:true});await f.update('4',{state:'waiting',waitReason:'Input'});
 const letter=await f.run('reply','--id','4','--ask','Choice','--text','Which one?');await f.brief('3','Progress');
 assert.equal((await f.run('tree'))[0].progress,33);
 await f.feedback('4',{annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.id},text:'A'}]});
 let tree=(await f.run('tree'))[0];assert.equal(tree.progress,33);assert.equal(tree.children[2].state,'waiting');
 await f.update('3',{state:'done'});assert.equal((await f.run('tree'))[0].progress,67);
 await f.update('4',{state:'done'});tree=(await f.run('tree'))[0];assert.equal(tree.progress,99);assert.equal(tree.state,'idle');
 await f.update('1',{state:'done'});tree=(await f.run('tree'))[0];assert.equal(tree.progress,100);assert.equal(tree.state,'done');
});
test('Done requires all descendants; reopening or adding children reopens only Done ancestors',async t=>{
 const f=await fixture(t);
 await f.run('create','--title','Root','--criteria','Whole outcome');
 await f.run('create','--title','Branch','--parent','1','--criteria','Branch outcome');
 await f.run('create','--title','Leaf','--parent','2');
 await f.run('create','--title','Sibling','--parent','1');
 await assert.rejects(f.update('1',{state:'done'}),/unfinished SubGoals.*#2.*#3.*#4/);
 assert.equal((await f.run('show','--id','1')).goal.state,'idle');
 await f.update('3',{state:'done'});
 let saved=await f.update('2',{state:'done'});
 assert.deepEqual(saved.nextActions.ancestors.map(a=>[a.id,a.criteria,a.state]),[['1','Whole outcome','idle']]);
 await assert.rejects(f.update('1',{state:'done'}),/#4 "Sibling"/);
 await f.update('4',{state:'done'});await f.update('1',{state:'done'});
 await f.update('3',{state:'waiting',waitReason:'Recheck'});
 let tree=(await f.run('tree'))[0];
 assert.equal((await f.run('show','--id','1')).root.state,'waiting');
 for(const id of ['1','2'])assert.equal(JSON.parse(await readFile(join(f.root,`workspace/goals/${id}/goal.json`))).state,'idle');
 assert.equal(tree.children[1].state,'done','unrelated sibling remains complete');
 await f.update('3',{state:'done'});await f.update('2',{state:'done'});await f.update('1',{state:'done'});
 await f.run('create','--title','New leaf','--parent','2');
 for(const id of ['1','2'])assert.equal(JSON.parse(await readFile(join(f.root,`workspace/goals/${id}/goal.json`))).state,'idle');
 assert.equal((await f.run('tree'))[0].children[1].state,'done');
 await f.run('create','--title','Other root');await f.update('6',{state:'done'});
 await f.update('4',{parentId:'6'});
 assert.equal(JSON.parse(await readFile(join(f.root,'workspace/goals/6/goal.json'))).state,'idle','moving even a Done child changes its new parent scope');
});
test('concurrent child creation and parent completion never leave Done over an unfinished child',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');
 await Promise.allSettled([f.update('1',{state:'done'}),f.run('create','--title','Added concurrently','--parent','1')]);
 const tree=(await f.run('tree'))[0];assert.equal(tree.state,'idle');assert.equal(tree.children.length,1);
 await assert.rejects(f.update('1',{state:'done'}),/unfinished SubGoals/);
});
test('runtime rejects obsolete schemas without modifying data',async t=>{
 const f=await fixture(t,'json');await f.run('create','--title','Current');
 const path=join(f.root,'workspace/schema.json'),old=JSON.stringify({format:'goal-workspace',version:3});await writeFile(path,old);
 await assert.rejects(f.run('tree'),/Unsupported workspace/);assert.equal(await readFile(path,'utf8'),old);
});

test('legacy no-reply Letters preserve counts without exposing a separate message kind',async t=>{
 const f=await fixture(t);await f.run('create','--title','Outcomes');
 const question=await f.run('reply','--id','1','--ask','Choose','--text','A or B?');
 const notice=await f.legacy({goalId:'1',type:'letter',replyRequired:false,title:'Ready',text:'Open the artifact.'});
 assert.equal(notice.replyRequired,false);
 assert.deepEqual((await f.run('show','--id','1')).letters.map(e=>e.id),[question.id]);
 assert.equal((await f.run('tree'))[0].letterCount,1);
 assert.doesNotMatch((await f.invoke('show','--id','1','--format','text')).stdout,/No reply needed|Comment target · Notice/);
 await f.feedback('1',{annotations:[{kind:'letter',source:{kind:'comment',eventId:notice.id},text:'An optional correction'}]});
 const page=await f.run('show','--id','1');assert.equal(page.goal.storedState,'idle');
 assert.deepEqual(page.letters,[],'the comment answers the open question');
 const kept=page.conversation.find(e=>e.id===notice.id);assert.equal(kept.receivedAt,undefined);assert.equal(kept.changeId,notice.changeId,'a notice is never closed');
 assert.equal((await f.run('close-letter','--id','1','--event',String(notice.id))).changed,false);
 await assert.rejects(f.run('reply','--id','1','--no-reply','--text','x'),/Unknown option/);
 await assert.rejects(f.feedback('1',{type:'letter',replyRequired:false,title:'x',text:'x'}),/replyRequired/);
});
test('editable sources from before the Deliverable rename move to their new names once',async t=>{
 const f=await fixture(t);await f.run('create','--title','Renamed');
 const dir=join(f.root,'workspace/goals/1');
 const {rm:remove}=await import('node:fs/promises');await remove(join(dir,'deliverable.md'),{force:true});
 await writeFile(join(dir,'brief.md'),'# Earlier source');
 const {path}=await f.run('deliverable','path','--id','1','--format','markdown');
 assert.equal(path,join(dir,'deliverable.md'));assert.equal(await readFile(path,'utf8'),'# Earlier source');
 await assert.rejects(readFile(join(dir,'brief.md'),'utf8'));
 // An existing new source is never overwritten by a leftover earlier one.
 await writeFile(join(dir,'brief.md'),'# Leftover');
 await f.run('deliverable','path','--id','1','--format','markdown');
 assert.equal(await readFile(path,'utf8'),'# Earlier source');
 await assert.rejects(f.invoke('brief','path','--id','1'),/renamed to goal deliverable/);
});

test('an agent Comment or Letter posted by mistake can be deleted; user comments cannot',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');
 const kept=await f.run('reply','--id','1','--text','Keep this');
 const wrong=await f.run('reply','--id','1','--text','Posted to the wrong project');
 const letter=await f.run('reply','--id','1','--ask','Wrong question','--text','Which one?');
 const user=await f.feedback('1',{text:'A user comment'});
 const deleted=await f.run('delete-comment','--id','1','--event',String(wrong.id));assert.equal(deleted.changed,true);
 await f.run('delete-comment','--id','1','--event',String(letter.id));
 assert.equal((await f.run('delete-comment','--id','1','--event',String(wrong.id))).changed,false,'deleting again changes nothing');
 const text=(await f.invoke('show','--id','1','--format','text')).stdout;
 assert.match(text,/Keep this/);assert.doesNotMatch(text,/wrong project|Wrong question/);
 assert.equal((await f.run('show','--id','1')).letters.length,0,'a deleted Letter is not open');
 await assert.rejects(f.invoke('delete-comment','--id','1','--event',String(user.id)),/Only agent/);
 await assert.rejects(f.invoke('delete-comment','--id','1','--event','999'),/not found/);
 assert.ok(kept.id);
});
test('large titles and feedback are accepted instead of hitting small caps',async t=>{
 const f=await fixture(t),title='T'.repeat(5000),text='x'.repeat(300000);
 assert.equal((await f.run('create','--title',title)).title,title);
 assert.equal((await f.feedback('1',{text})).text.length,text.length);
});
test('a user comment after a Letter answers it and shows it as Replied; one before it does not',async t=>{
 const f=await fixture(t);await f.run('create','--title','Root');
 await f.feedback('1',{text:'Earlier note'});
 const letter=await f.run('reply','--id','1','--ask','Go ahead?','--text','May I proceed?');
 assert.deepEqual((await f.run('show','--id','1')).letters.map(l=>l.id),[letter.id]);
 const reply=await f.feedback('1',{text:'Yes, go ahead.'});
 const page=await f.run('show','--id','1');assert.equal(page.letters.length,0);
 const closed=page.conversation.find(e=>e.id===letter.id);assert.equal(closed.answeredBy,reply.id);assert.equal(closed.changeId,reply.id+1);
 const {letterState}=await import('../public/letter-state.js');
 assert.deepEqual(letterState(closed,[]),{status:'answered',lastAnswerId:reply.id});
 const again=await f.run('close-letter','--id','1','--event',String(letter.id));assert.equal(again.changed,false);assert.equal(again.status,'answered');
});
