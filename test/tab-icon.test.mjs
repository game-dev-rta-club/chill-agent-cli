import test from 'node:test';
import assert from 'node:assert/strict';
import {createTabIcon} from '../public/tab-icon.js';

test('the tab icon adds a dot while the agent works and restores the original after',()=>{
 const idle="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect/%3E%3C/svg%3E";
 const attrs={href:idle},link={getAttribute:name=>attrs[name],setAttribute:(name,value)=>{attrs[name]=value;}};
 const icon=createTabIcon(link);
 icon.set(true);assert.match(attrs.href,/%3Ccircle [^%]*fill='%23d9822b'.*%3C\/svg%3E$/);assert.ok(attrs.href.startsWith(idle.slice(0,-9)));
 icon.set(false);assert.equal(attrs.href,idle);
 assert.doesNotThrow(()=>createTabIcon(null).set(true));
});
