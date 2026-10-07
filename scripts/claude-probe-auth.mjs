// Explicit opt-in reuse of native user settings for an isolated protocol probe.
// Secrets stay in process memory; never copy the settings file or log values.
import {readFile} from 'node:fs/promises';

export const authNames=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS'];
export async function probeAuthSettings(path) {
  let settings;
  try {settings=JSON.parse(await readFile(path,'utf8'));}
  catch {throw Error('Could not read the explicit probe authentication settings.');}
  const source=settings?.env;
  if(!source || typeof source!=='object' || Array.isArray(source))throw Error('No environment authentication in the explicit settings.');
  if(settings.apiKeyHelper || Object.keys(source).some(key=>key.startsWith('CLAUDE_CODE_USE_') && source[key] && source[key]!=='0'))
    throw Error('This probe does not import helpers or alternate provider settings. Use the native provider setup separately.');
  const env={};
  for(const name of authNames) {
    if(source[name]===undefined)continue;
    if(typeof source[name]!=='string'||!source[name]||source[name].includes('\0'))throw Error('Invalid native authentication environment setting.');
    env[name]=source[name];
  }
  if(!env.ANTHROPIC_API_KEY&&!env.ANTHROPIC_AUTH_TOKEN)throw Error('No API credential in the explicit settings.');
  if(settings.model!==undefined&&(typeof settings.model!=='string'||!settings.model||settings.model.length>200))throw Error('Invalid native model preference.');
  return {env,model:settings.model??null};
}
