import {callerOwns,agentKey as defaultAgentKey} from './agents/index.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {requireProtocol, storage, listGoals, readGoalContext, readFeedback, readNotificationSettings,
  saveMessageSetting, validateNotifications, notificationUrl, dataDirectory, touch,workspacePort} from './extension-api.mjs';

requireProtocol(1);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const profileId = value => createHash('sha256').update(JSON.stringify([value.tool,value.destination,[...value.on].sort()])).digest('hex').slice(0,24);
const excerpt = text => {const chars=Array.from(text.trim());return chars.length>400?chars.slice(0,397).join('')+'…':text.trim();};

export function createNotifications({store=storage('notifications'),goals=listGoals,context=readGoalContext,events=readFeedback,
  legacy=readNotificationSettings,disableLegacy=()=>saveMessageSetting('notifications',{enabled:false}),url=notificationUrl,
  now=()=>new Date().toISOString(),uuid=randomUUID,owns=root=>callerOwns(root),agentKey=defaultAgentKey,use=touch}={}) {
  const cursor = items => Math.max(0,...items.map(e=>e.id));
  async function state() {
    const saved=await store.read('1');
    if(saved){if(saved.version!==1)throw Error('Unsupported notification data version.');return saved;}
    const previous=await legacy(),all=await goals(),cutoff=cursor(await events());
    const s={version:1,profiles:{},roots:{},claims:{},defaultProfile:null};
    if(previous.tool){const id=profileId(previous);s.profiles[id]={id,tool:previous.tool,destination:previous.destination,on:previous.on};s.defaultProfile=id;}
    // Preserve the prior setting only for Roots that already exist. New Roots start Off.
    for(const root of all.filter(g=>!g.parentId))s.roots[root.id]={enabled:previous.enabled,profileId:s.defaultProfile,cutoff};
    return s;
  }
  async function change(run) {
    return store.lock('1',async()=>{
      const s=await state(),result=await run(s);
      await store.write('1',s);
      // Old saved commands must not use the former global On setting as a bypass.
      if((await legacy()).enabled)await disableLegacy();
      return result;
    });
  }
  function connection(s,id){const r=s.roots[id];return s.profiles[r?.profileId||s.defaultProfile]||null;}
  async function settings(goalId) {
    const s=await state();
    if(!goalId)return {enabled:Object.values(s.roots).some(r=>r.enabled),on:[...new Set(Object.values(s.profiles).flatMap(p=>p.on))],profiles:Object.values(s.profiles),roots:s.roots};
    const {root}=await context(goalId),r=s.roots[root.id],p=connection(s,root.id);
    return {rootId:root.id,enabled:Boolean(r?.enabled&&p),configured:Boolean(p),...(p?{profileId:p.id,tool:p.tool,destination:p.destination,on:p.on}:{on:[]})};
  }
  // Only the Root's own agent conversation may notify for it.
  async function assertOwner(root){if(!agentKey(root)||!await owns(root))throw Error('Use the assigned Agent chat for this notification.');}
  // Claims belong to the agent connection; earlier claims recorded a Codex threadId.
  const sameAgent=(claim,root)=>claim.agent?claim.agent===agentKey(root):Boolean(root.threadId)&&claim.threadId===root.threadId;
  return {
    settings,
    initialize:()=>change(()=>null),
    async configure(goalId,input,expectedRoot) {
      const {root}=await context(goalId);
      if(expectedRoot&&expectedRoot!==root.id)throw Error('Goal moved. Refresh to retry.');
      const result=await change(async s=>{
        if((await context(goalId)).root.id!==root.id)throw Error('Goal moved. Refresh to retry.');
        const previous=s.roots[root.id]||{enabled:false,profileId:s.defaultProfile,cutoff:cursor(await events())};
        let id=previous.profileId||s.defaultProfile;
        if(typeof input.enabled!=='boolean')throw Error('enabled must be a boolean.');
        if(input.profileId!==undefined){
          if(Object.keys(input).some(k=>!['enabled','profileId'].includes(k))||!s.profiles[input.profileId])throw Error('Choose a saved notification profile.');
          id=input.profileId;
        }else if(input.tool!==undefined){
          const p=validateNotifications(input);id=profileId(p);
          s.profiles[id]={id,tool:p.tool,destination:p.destination,on:p.on};s.defaultProfile=id;
        }else if(Object.keys(input).some(k=>k!=='enabled'))throw Error('Unknown notification setting.');
        if(input.enabled&&!s.profiles[id])throw Error('Set up a notification connection first.');
        const changed=previous.enabled!==input.enabled||previous.profileId!==id;
        s.roots[root.id]={...previous,profileId:id,enabled:input.enabled,cutoff:changed?cursor(await events()):previous.cutoff};
        return {rootId:root.id,...s.roots[root.id]};
      });
      await use();return result;
    },
    async prepare(goalId,eventId) {
      if(!Number.isSafeInteger(eventId)||eventId<1)throw Error('Use a saved event ID.');
      const {root,goal}=await context(goalId);await assertOwner(root);
      return change(async s=>{
        const fresh=(await context(goalId)).root;
        if(fresh.id!==root.id||agentKey(fresh)!==agentKey(root))throw Error('Goal or Agent changed. Refresh to retry.');
        const r=s.roots[root.id],p=connection(s,root.id);
        const event=(await events()).find(e=>e.id===eventId&&e.goalId===goal.id&&e.author==='agent');
        if(!event)throw Error('Agent Comment or Letter not found. Save it first.');
        if(!r?.enabled||!p||!p.on.includes(event.type))return {enabled:false};
        if(Object.values(s.claims).some(c=>c.eventId===eventId))return {enabled:false,reason:'Already prepared. Check history; do not send again.'};
        if(eventId<=r.cutoff)return {enabled:false,reason:'Predates current notification settings.'};
        const link=await url(goal.id,event);
        const title=event.title||goal.title;
        const message=`${title}\n${excerpt(event.text||'')}${link?'\n'+link:''}`;
        const id=uuid(),at=now();
        const claim={id,rootId:root.id,goalId:goal.id,eventId,agent:agentKey(root),at,title,message,url:link,tool:p.tool,destination:p.destination,profileId:p.id,result:null};
        s.claims[id]=claim;
        const prefix=`PORT=${quote(workspacePort())} CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(process.execPath)} ${quote(join(dataDirectory(),'runtime','chill.mjs'))}`;
        return {enabled:true,noticeId:id,tool:p.tool,destination:p.destination,message,url:link,
          resultCommand:`${prefix} settings notice-result --id ${root.id} --notice ${id} --outcome <sent|failed|unconfirmed>`,
          note:'Send this exact message once. Sent means host-tool acceptance, not device delivery. Missing receipt must not be retried.'};
      });
    },
    async result(goalId,id,outcome) {
      if(!['sent','failed','unconfirmed'].includes(outcome))throw Error('Use sent, failed or unconfirmed.');
      const {root}=await context(goalId);await assertOwner(root);
      return change(async s=>{
        const fresh=(await context(goalId)).root;
        if(fresh.id!==root.id||agentKey(fresh)!==agentKey(root))throw Error('Goal or Agent changed. Refresh to retry.');
        const claim=s.claims[id];
        if(!claim||claim.rootId!==root.id||!sameAgent(claim,root))throw Error('Notification does not belong to this Root and Agent.');
        if(claim.result){if(claim.result.outcome!==outcome)throw Error('A different result is already recorded.');return claim.result;}
        return claim.result={outcome,at:now()};
      });
    },
    async control(goalId,{activity=false}={}) {
      const {root}=await context(goalId);if(!agentKey(root))return null;
      const s=await state(),r=s.roots[root.id],p=connection(s,root.id);
      const entries=Object.values(s.claims).filter(c=>c.rootId===root.id&&sameAgent(c,root)).reverse();
      return {rootId:root.id,enabled:Boolean(r?.enabled&&p),icon:'bell',configured:Boolean(p),
        description:'Notifies you when a result or decision needs your attention.',
        detail:p?p.destination:'Not set up',
        setup:{label:p?'Change':'Set up',text:`Review the saved notification settings for Root Goal #${root.id} with settings show --id ${root.id}. For browser notifications, direct the user to More → Notifications in the intended browser. For an existing host-tool route, use settings --help and preserve the agreed destination and occasions unless the user asks to change them.`},
        ...(activity?{activity:{label:'Notifications',total:entries.length,entries:entries.slice(0,20).map(c=>({id:c.id,at:c.at,summary:c.title,message:c.message,
          status:c.result?{sent:'Sent',failed:'Failed',unconfirmed:'Unconfirmed'}[c.result.outcome]:'Unconfirmed',
          detail:c.destination,
          result:c.result?{label:{sent:'Sent',failed:'Failed',unconfirmed:'Unconfirmed'}[c.result.outcome],at:c.result.at}:null}))}}:{})};
    },
  };
}

export const notifications=createNotifications();
export function createExtension(){return {id:'notifications',label:'Notifications',
  start:async()=>{try{await notifications.initialize();}catch(error){console.error('Notifications unavailable:',error.message);}},
  read:async(id,options)=>{
    try{return {...await notifications.control(id,options),menu:false};}catch{
      const {root}=await readGoalContext(id);if(!defaultAgentKey(root))return null;
      return {rootId:root.id,enabled:false,configured:false,icon:'bell',detail:'Settings unavailable',
        setup:{label:'Review',text:'Read settings show --id for this Root and settings --help to diagnose the unavailable notification settings. Do not send a test or replace the destination without agreement.'},
        ...(options.activity?{activity:{label:'Notifications',entries:[],total:0}}:{})};
    }
  },
  set:(id,input)=>notifications.configure(id,{enabled:input.enabled},input.rootId)};}
