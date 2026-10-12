import codex from './codex-desktop.mjs';
import claude from './claude-code.mjs';
import {onboarding} from '../../lib/session-onboarding.mjs';
// Trusted code only: neither project settings nor tool input chooses modules.
const adapters=new Map([codex,claude].map(adapter=>[adapter.id,adapter]));
export function harnessAdapter(id){
 const adapter=adapters.get(id);
 if(!adapter)throw Error(`Unknown harness: ${id||'(missing)'}. Supported: ${[...adapters.keys()].join(', ')}. Select the calling harness explicitly; no fallback connection is made.`);
 return adapter;
}
export function harnessGuidance(id){const adapter=harnessAdapter(id);return {harnessId:adapter.id,...structuredClone({...adapter.guidance,onboarding})};}

export function supportedHarnesses(){return [...adapters.keys()];}
