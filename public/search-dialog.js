// More → Search opens this dialog. Results follow the typing, but only after a
// short pause, and a newer query cancels the one still on its way, so fast
// typing sends a few requests instead of one per key.
const pause=250;
const kinds={goal:'Goal',deliverable:'Deliverable',comment:'Comment',letter:'Letter'};
export function createSearchDialog() {
 const dialog=document.createElement('dialog');dialog.className='search-dialog';dialog.setAttribute('aria-labelledby','search-title');
 dialog.innerHTML='<div class="extension-panel-heading"><h2 id="search-title">Search</h2><button type="button" aria-label="Close search">×</button></div><input type="search" class="search-input" placeholder="Goals, Comments, Letters, Deliverables" aria-label="Search text" autocomplete="off" spellcheck="false"><p class="search-status agent-muted" role="status"></p><ol class="search-results"></ol>';
 document.body.append(dialog);
 const input=dialog.querySelector('input'),status=dialog.querySelector('[role=status]'),list=dialog.querySelector('ol');
 let timer=0,controller=null,shown='';
 const say=text=>{status.textContent=text;};
 const hint=()=>say('Words separated by spaces must all appear.');
 const link=item=>`#/goal/${item.goalId}${item.kind==='letter'?`/letter/${item.eventId}`:item.kind==='comment'?`/activity/${item.eventId}`:''}`;
 // Plain text with each search word marked; nothing from the result is parsed as HTML.
 // Matching folds width and case per character, so each folded position maps back to the written text.
 function marked(text,terms) {
  let folded='';const written=[];
  for(let i=0;i<text.length;){const ch=String.fromCodePoint(text.codePointAt(i)),f=ch.normalize('NFKC').toLowerCase();for(let k=0;k<f.length;k++)written.push(i);folded+=f;i+=ch.length;}
  written.push(text.length);
  const out=document.createDocumentFragment();let at=0,from=0;
  while(from<folded.length){
   let next=-1,size=0;
   for(const term of terms){const i=folded.indexOf(term,from);if(i>=0&&(next<0||i<next||(i===next&&term.length>size))){next=i;size=term.length;}}
   if(next<0)break;
   const start=written[next],end=Math.max(written[next+size],start+1);
   if(start>=at){out.append(text.slice(at,start));const mark=document.createElement('mark');mark.textContent=text.slice(start,end);out.append(mark);at=end;}
   from=next+size;
  }
  out.append(text.slice(at));return out;
 }
 function render({results,more,terms}) {
  list.replaceChildren(...results.map(item=>{
   const row=document.createElement('li'),a=document.createElement('a');a.href=link(item);a.className='search-result';
   const where=document.createElement('span');where.className='search-where';
   const label=item.kind==='comment'||item.kind==='letter'?`${kinds[item.kind]}${item.number?` ${item.number}`:''} · ${item.author==='user'?'You':'Agent'}`:item.kind==='deliverable'?`Deliverable v${item.version}`:kinds.goal;
   const date=item.updatedAt?new Date(item.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'';
   where.textContent=`#${item.goalId} ${item.goalTitle} · ${label}${date?` · ${date}`:''}`;
   const text=document.createElement('span');text.className='search-snippet';text.append(marked(item.snippet,terms));
   a.append(where,text);a.onclick=()=>dialog.close();row.append(a);return row;
  }));
  say(results.length?more?`Showing the newest ${results.length} matches. Add a word to narrow them down.`:`${results.length} ${results.length===1?'match':'matches'}`:'No matches.');
 }
 async function run(query) {
  controller?.abort();const current=controller=new AbortController(),signal=current.signal;
  say('Searching…');let late=false;const limit=setTimeout(()=>{late=true;current.abort();},10000);
  try{
   const response=await fetch(`/api/search?q=${encodeURIComponent(query)}`,{signal});
   if(!response.ok)throw Error();
   const result=await response.json();if(signal.aborted)return;
   shown=query;render(result);
  }catch{if(late||!signal.aborted)say('Could not search. Try again.');}
  finally{clearTimeout(limit);}
 }
 input.addEventListener('input',()=>{
  clearTimeout(timer);const query=input.value.trim();
  if(!query){controller?.abort();shown='';list.replaceChildren();hint();return;}
  if(query===shown)return;
  timer=setTimeout(()=>run(query),pause);
 });
 input.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  // A search field clears itself on Escape; here Escape closes, keeping the words for next time.
  if(event.key==='Escape'){event.preventDefault();dialog.close();return;}
  const first=list.querySelector('a');
  if(event.key==='Enter'&&first){event.preventDefault();first.click();}
  else if(event.key==='ArrowDown'&&first){event.preventDefault();first.focus();}
 });
 list.addEventListener('keydown',event=>{
  const links=[...list.querySelectorAll('a')],i=links.indexOf(document.activeElement);if(i<0)return;
  if(event.key==='ArrowDown'){event.preventDefault();links[Math.min(i+1,links.length-1)].focus();}
  else if(event.key==='ArrowUp'){event.preventDefault();(i?links[i-1]:input).focus();}
 });
 dialog.querySelector('.extension-panel-heading button').onclick=()=>dialog.close();
 // A click on the backdrop lands on the dialog element itself.
 dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
 dialog.addEventListener('close',()=>{clearTimeout(timer);controller?.abort();});
 return {
  open(){
   if(dialog.open)return;dialog.showModal();input.focus();input.select();
   // A search cut short by closing runs again for the words still in the field.
   const query=input.value.trim();if(!query)hint();else if(query!==shown)void run(query);
  },
  close(){if(dialog.open)dialog.close();},
 };
}
