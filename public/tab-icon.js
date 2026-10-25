// The tab icon shows the agent's state on the open Goal in the Root's icon set:
// an outline sunrise while idle, a yellow sun while it waits for a check it
// scheduled, and a warm sky with long rays while it works. It uses no title space.
// The header's icon mirrors it, so the page shows the same state and set.
import {defaultTabIcon,tabIconSet} from './theme-catalog.js';
export function createTabIcon(link=document.querySelector('link[rel="icon"]'),icons=globalThis.document?.documentElement.dataset.tabIcon||defaultTabIcon,mirror=null){
 if(!link)return {set(){},use(){}};
 let state=null,set=tabIconSet(icons);
 const show=()=>{const href=state==='working'?set.working:state==='waiting'?set.waiting:set.idle;if(link.getAttribute('href')!==href)link.setAttribute('href',href);if(mirror&&mirror.getAttribute('src')!==href)mirror.setAttribute('src',href);};
 show();
 return {set(value){state=value;show();},use(id){set=tabIconSet(id);show();}};
}
