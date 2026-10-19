import {projectExtensionEnabled} from './extension-api.mjs';
import {notifications as tools} from './notifications.mjs';
import {webNotifications as web} from './web-notifications.mjs';
export const notifications={
 async settings(goalId){const [a,b]=await Promise.all([projectExtensionEnabled('notifications')?tools.settings(goalId):{enabled:false,on:[]},projectExtensionEnabled('web-notifications')?web.settings(goalId):{enabled:false,on:[]}]);if(goalId&&b.selected)return {...b,webPush:b};return {...a,enabled:a.enabled||b.enabled,on:[...new Set([...a.on,...b.on])],webPush:b};},
 configure:(...args)=>{if(!projectExtensionEnabled('notifications'))throw Error('Tool notifications are disabled for this project.');return tools.configure(...args);},
 async prepare(goalId,eventId){
  const b=projectExtensionEnabled('web-notifications')?await web.settings(goalId):{selected:false};
  if(b.selected)return web.prepare(goalId,eventId);
  return projectExtensionEnabled('notifications')?tools.prepare(goalId,eventId):{enabled:false,reason:'Tool notifications are disabled for this project.'};
 },
 result:(...args)=>tools.result(...args),
};
