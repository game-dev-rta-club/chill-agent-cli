import {dataDirectory} from './data-directory.mjs';
import {listGoals,readFeedback,readBrief,goalNumbers} from './goal-store.mjs';
import {briefText} from './brief.mjs';
// Search reads every visible Goal, Comment, Letter and latest Canvas as
// plain text. Typing sends a query per pause, so the text is kept for a few
// seconds and shared by requests that arrive while it is being read; a busy
// workspace costs one read per few seconds, not one per keystroke.
const fresh=3000,limit=50,maxTerms=8,maxQuery=100,before=30,after=90;
let cached=null,reading=null;
const deliverableText=new Map();
// Matching ignores width and case (ｃｈｉｌｌ finds chill); results show the text as written.
const flat=text=>String(text||'').replace(/\s+/g,' ').trim(),fold=text=>text.normalize('NFKC').toLowerCase();
const entry=(item,text)=>{const shown=flat(text);return {...item,shown,folded:fold(shown)};};
async function readCorpus() {
 const goals=await listGoals(),visible=new Map(goals.map(goal=>[goal.id,goal])),items=[],kept=new Set();
 for(const goal of goals)items.push(entry({kind:'goal',goalId:goal.id,updatedAt:goal.updatedAt,titleText:fold(flat(goal.title))},[goal.title,goal.scope,goal.criteria].filter(Boolean).join(' · ')));
 for(const goal of goals){
  const brief=await readBrief(goal.id);if(!brief?.body)continue;
  // A published version never changes, so its text is extracted once.
  const key=`${goal.id}:${brief.version}`;kept.add(key);
  if(!deliverableText.has(key))deliverableText.set(key,briefText(brief.body,brief.format));
  items.push(entry({kind:'deliverable',goalId:goal.id,version:brief.version,updatedAt:brief.createdAt||goal.updatedAt},deliverableText.get(key)));
 }
 for(const key of deliverableText.keys())if(!kept.has(key))deliverableText.delete(key);
 const events=await readFeedback(),numbers=goalNumbers(events);
 for(const event of events){
  if(event.deletedAt||!visible.has(event.goalId)||!['comment','letter'].includes(event.type))continue;
  const text=[event.title,event.text].filter(Boolean).join(' · ');if(!text)continue;
  items.push(entry({kind:event.type,goalId:event.goalId,eventId:event.id,number:numbers.get(event.id),author:event.author,updatedAt:event.updatedAt},text));
 }
 return {titles:new Map(goals.map(goal=>[goal.id,goal.title])),items};
}
async function corpus() {
 const directory=dataDirectory();
 if(cached?.directory===directory&&Date.now()-cached.at<fresh)return cached.value;
 if(reading?.directory===directory)return reading.value;
 const value=readCorpus();reading={directory,value};
 try{const result=await value;cached={directory,at:Date.now(),value:result};return result;}
 finally{if(reading?.value===value)reading=null;}
}
export function searchTerms(query) {
 return [...new Set(fold(flat(String(query||'').slice(0,maxQuery))).split(' ').filter(Boolean))].slice(0,maxTerms);
}
// Folding can lengthen a character (… becomes ...), so a position in the folded
// text is walked back to the written text one character at a time.
function writtenIndex(text,foldedIndex) {
 let folded=0,i=0;
 while(i<text.length){const ch=String.fromCodePoint(text.codePointAt(i)),size=fold(ch).length;if(folded+size>foldedIndex)break;folded+=size;i+=ch.length;}
 return i;
}
function snippet(item,terms) {
 const at=writtenIndex(item.shown,Math.min(...terms.map(term=>item.folded.indexOf(term)))),text=item.shown,start=Math.max(0,at-before),end=Math.min(text.length,at+after);
 return `${start?'…':''}${text.slice(start,end)}${end<text.length?'…':''}`;
}
// Every term must appear. Goals come first, title matches before the rest;
// Canvases, Comments and Letters follow, newest first.
export async function searchWorkspace(query) {
 const terms=searchTerms(query);if(!terms.length)return {terms,results:[],more:false};
 const {titles,items}=await corpus(),found=items.filter(item=>terms.every(term=>item.folded.includes(term)));
 const rank=item=>item.kind!=='goal'?2:terms.every(term=>item.titleText.includes(term))?0:1;
 found.sort((a,b)=>rank(a)-rank(b)||Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0)||(b.eventId||0)-(a.eventId||0));
 return {terms,more:found.length>limit,results:found.slice(0,limit).map(({shown,folded,titleText,...item})=>({...item,goalTitle:titles.get(item.goalId)||'',snippet:snippet({shown,folded},terms)}))};
}
