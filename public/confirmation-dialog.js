// A DOM-based confirmation shared by trusted extension panels.
export function confirmAction({title,message,confirmLabel='Continue',cancelLabel='Cancel',signal}={}){
 if(signal?.aborted)return Promise.resolve(false);
 return new Promise(resolve=>{
  const dialog=document.createElement('dialog');dialog.className='extension-confirm';
  const id=`confirm-${crypto.randomUUID()}`,heading=document.createElement('h2'),body=document.createElement('p'),actions=document.createElement('div'),cancel=document.createElement('button'),accept=document.createElement('button');
  heading.id=`${id}-title`;heading.textContent=title;body.id=`${id}-message`;body.textContent=message;
  dialog.setAttribute('aria-labelledby',heading.id);dialog.setAttribute('aria-describedby',body.id);
  cancel.type=accept.type='button';cancel.textContent=cancelLabel;accept.textContent=confirmLabel;accept.className='extension-confirm-accept';actions.append(cancel,accept);dialog.append(heading,body,actions);
  let finished=false;
  const done=result=>{if(finished)return;finished=true;signal?.removeEventListener('abort',abort);dialog.close();dialog.remove();resolve(result);};
  const abort=()=>done(false);
  cancel.onclick=()=>done(false);accept.onclick=()=>done(true);
  dialog.addEventListener('cancel',event=>{event.preventDefault();done(false);});
  signal?.addEventListener('abort',abort,{once:true});document.body.append(dialog);dialog.showModal();cancel.focus();
 });
}
