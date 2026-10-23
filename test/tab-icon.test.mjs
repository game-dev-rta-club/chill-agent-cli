import test from 'node:test';
import assert from 'node:assert/strict';
import {createTabIcon,waitingIcon,workingIcon} from '../public/tab-icon.js';

test('the tab icon takes color while the agent works, turns yellow while it waits for a check, and restores the original after',()=>{
 const idle="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect/%3E%3C/svg%3E";
 const attrs={href:idle},link={getAttribute:name=>attrs[name],setAttribute:(name,value)=>{attrs[name]=value;}};
 const icon=createTabIcon(link);
 icon.set('working');assert.equal(attrs.href,workingIcon);assert.match(decodeURIComponent(workingIcon),/stroke='#e2702a'.*stroke='#2c7bb6'/);
 icon.set('waiting');assert.equal(attrs.href,waitingIcon);assert.match(decodeURIComponent(waitingIcon),/fill='#e6ab17'/);
 icon.set(null);assert.equal(attrs.href,idle);
 assert.doesNotThrow(()=>createTabIcon(null).set('working'));
});
