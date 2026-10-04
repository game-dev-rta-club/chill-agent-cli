import {readFile} from 'node:fs/promises';
const manifest=await readFile(new URL('../extensions.json',import.meta.url),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {modules:[]};throw e;});
const modules=await Promise.all((manifest.modules||[]).map(path=>import(new URL(path,new URL('../',import.meta.url)))));
export const registeredExtensions=()=>process.env.CHILL_AGENT_EXTENSIONS==='none'?[]:modules.map(m=>m.createExtension());
