// The tab icon shows the agent's state on the open Goal in the Root's icon set:
// an outline sunrise while idle, a yellow sun while it waits for a check it
// scheduled, and a warm sky with long rays while it works. While chill updates
// or cannot be reached, a gray circular arrow covers them. It uses no title space.
// The header's icon mirrors it, so the page shows the same state and set.
import {defaultTabIcon,tabIconSet,updatingTabIcon} from './theme-catalog.js';
export function createTabIcon(link=document.querySelector('link[rel="icon"]'),icons=globalThis.document?.documentElement.dataset.tabIcon||defaultTabIcon,mirror=null){
 if(!link)return {set(){},use(){},updating(){}};
 let state=null,set=tabIconSet(icons),updating=false;
 const show=()=>{const href=updating?updatingTabIcon:state==='working'?set.working:state==='waiting'?set.waiting:set.idle;if(link.getAttribute('href')!==href)link.setAttribute('href',href);if(mirror&&mirror.getAttribute('src')!==href)mirror.setAttribute('src',href);};
 show();
 return {set(value){state=value;show();},use(id){set=tabIconSet(id);show();},updating(value){updating=Boolean(value);show();}};
}
