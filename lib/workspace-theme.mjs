import {join} from 'node:path';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {defaultTheme,validTheme} from '../public/theme-catalog.js';
export async function readWorkspaceTheme(directory=dataDirectory()) {
 const stored=await readJson(join(directory,'appearance.json'));
 return {theme:validTheme(stored?.theme)?stored.theme:defaultTheme};
}
export async function saveWorkspaceTheme(input,directory=dataDirectory()) {
 if(!input||!validTheme(input.theme)||Object.keys(input).some(key=>key!=='theme'))throw Error('Choose a listed theme.');
 return withStoreLock(join(directory,'locks','appearance'),async()=>{
  const value={theme:input.theme};await writeJsonAtomically(join(directory,'appearance.json'),value);return value;
 });
}
