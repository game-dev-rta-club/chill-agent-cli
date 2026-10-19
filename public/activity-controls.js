const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The Pause or Resume button of a Goal's agent, after its conversation.
export function activityControlMarkup(data,{pending=false,message='',uncertain=false}={}){
 if(!data)return '';
 const action=uncertain||data.status==='unknown'?'check':data.capabilities?.stop?'stop':data.capabilities?.resume?'resume':null;
 return `${action?`<button class="action activity-control" type="button" data-activity-control="${action}" ${pending?'disabled':''}><span aria-hidden="true">${action==='stop'?'Ⅱ':action==='resume'?'▶':'↻'}</span> ${action==='stop'?'Pause':action==='resume'?'Resume':'Refresh'}</button>`:''}${message?`<span class="activity-control-message" role="status">${escape(message)}</span>`:''}`;
}
export function createActivityControls({main,getGoalId,onChange}){
 let data=null,goalId=null,sequence=0,pending=false,message='',uncertain=false,refreshingGoal=null;
 const current=()=>goalId===getGoalId()?data:null;
 async function refresh(){
  const id=getGoalId();if(!id||pending||refreshingGoal===id)return;
  const token=++sequence;
  refreshingGoal=id;
  try{
   const response=await fetch(`/api/goals/${id}/agent/activity`,{cache:'no-store',signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error();const next=await response.json();
   if(token!==sequence||id!==getGoalId())return;
   const changed=goalId!==id||JSON.stringify(data)!==JSON.stringify(next);
   goalId=id;data=next;if(changed)onChange();
  }catch{
   if(token!==sequence||id!==getGoalId())return;
   // A stale button must never act on new work after losing contact.
   if(data){data=null;onChange();}
  }finally{if(token===sequence)refreshingGoal=null;}
 }
 main.addEventListener('click',async event=>{
  const button=event.target.closest('[data-activity-control]');if(!button||pending)return;
  const action=button.dataset.activityControl;
  if(action==='check'){uncertain=false;message='';await refresh();onChange();return;}
  const id=getGoalId(),snapshot=current();if(!snapshot)return;
  pending=true;message=action==='stop'?'Pausing…':'Resuming…';onChange();
  ++sequence;refreshingGoal=null;
  try{
   const response=await fetch(`/api/goals/${id}/agent/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,token:snapshot.token,turnId:snapshot.turnId}),signal:AbortSignal.timeout(30000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Action unconfirmed.');
   if(id===getGoalId()){message='';uncertain=false;}
  }catch(error){if(id===getGoalId()){message=error.name==='TimeoutError'?'Unconfirmed. Refresh to check.':error.message;uncertain=true;}}
  finally{pending=false;onChange();if(!uncertain)void refresh();}
 });
 return {refresh,current,
  controls(){return activityControlMarkup(current(),{pending,message,uncertain});},
  routeChanged(){sequence++;refreshingGoal=null;data=null;goalId=null;message='';uncertain=false;void refresh();},
 };
}
