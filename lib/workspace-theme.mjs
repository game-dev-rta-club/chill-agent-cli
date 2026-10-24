import {join} from 'node:path';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {defaultTheme,validTheme,defaultTabIcon,validTabIcon,tabIconSet,resolveAppearance,browserThemeColor} from '../public/theme-catalog.js';
const rootKey=/^[1-9][0-9]*$/;
// The project default comes first; Roots keep only the fields they chose. An
// older file holding just {theme} reads as the project default.
export async function readWorkspaceTheme(directory=dataDirectory()) {
 const stored=await readJson(join(directory,'appearance.json'))||{},roots={};
 for(const [id,value] of Object.entries(stored.roots||{})){
  const own={...(validTheme(value?.theme)?{theme:value.theme}:{}),...(validTabIcon(value?.tabIcon)?{tabIcon:value.tabIcon}:{})};
  if(rootKey.test(id)&&Object.keys(own).length)roots[id]=own;
 }
 return {theme:validTheme(stored.theme)?stored.theme:defaultTheme,tabIcon:validTabIcon(stored.tabIcon)?stored.tabIcon:defaultTabIcon,roots};
}
// Without rootId the choice changes the project default; with it, that Root
// alone. reset removes the Root's own choice so it follows the default again.
export async function saveWorkspaceTheme(input,directory=dataDirectory()) {
 const listed=input&&typeof input==='object'&&Object.keys(input).every(key=>['theme','tabIcon','rootId','reset'].includes(key))
  &&(input.theme===undefined||validTheme(input.theme))&&(input.tabIcon===undefined||validTabIcon(input.tabIcon));
 if(!listed)throw Error('Choose a listed theme.');
 const rootId=input.rootId===undefined?null:String(input.rootId);
 if(rootId!==null&&!rootKey.test(rootId))throw Error('Choose a Root Goal.');
 if(input.reset!==undefined&&(input.reset!==true||rootId===null||input.theme||input.tabIcon))throw Error('Only a Root can return to the project default.');
 if(!input.reset&&!input.theme&&!input.tabIcon)throw Error('Choose a listed theme.');
 return withStoreLock(join(directory,'locks','appearance'),async()=>{
  const current=await readWorkspaceTheme(directory),choice={...(input.theme?{theme:input.theme}:{}),...(input.tabIcon?{tabIcon:input.tabIcon}:{})};
  const roots={...current.roots};
  if(rootId&&input.reset)delete roots[rootId];else if(rootId)roots[rootId]={...roots[rootId],...choice};
  const value={...current,...(rootId?{}:choice),roots};
  await writeJsonAtomically(join(directory,'appearance.json'),value);return value;
 });
}
// The URL fragment never reaches the server, so the page carries each customized
// Root's look and which Goals belong to it; a small script picks one before paint.
export function appearanceBoot(stored,goals=[]) {
 const look=appearance=>({theme:appearance.theme,color:browserThemeColor(appearance.theme),icon:tabIconSet(appearance.tabIcon).idle});
 const byId=new Map(goals.map(goal=>[goal.id,goal])),rootOf=id=>{let goal=byId.get(id);for(let n=0;goal?.parentId&&byId.has(goal.parentId)&&n<byId.size;n++)goal=byId.get(goal.parentId);return goal?.id;};
 const members={};for(const goal of goals){const root=rootOf(goal.id);if(stored.roots[root])members[goal.id]=root;}
 return {stored,looks:Object.fromEntries(Object.keys(stored.roots).map(id=>[id,look(resolveAppearance(stored,id))])),goals:members};
}
