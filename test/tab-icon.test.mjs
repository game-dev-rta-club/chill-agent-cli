import test from 'node:test';
import assert from 'node:assert/strict';
import {createTabIcon} from '../public/tab-icon.js';
import {tabIcons,resolveAppearance} from '../public/theme-catalog.js';

test('the tab icon follows the agent state within the chosen icon set',()=>{
 const attrs={href:'initial'},link={getAttribute:name=>attrs[name],setAttribute:(name,value)=>{attrs[name]=value;}};
 const [morning,,night]=tabIcons,icon=createTabIcon(link,'morning');
 icon.set('working');assert.equal(attrs.href,morning.working);assert.match(decodeURIComponent(morning.working),/fill='#fdd9b5'.*stroke-width='2.8'.*stroke='#2c7bb6'/);
 icon.set('waiting');assert.equal(attrs.href,morning.waiting);assert.match(decodeURIComponent(morning.waiting),/fill='#dceee9'.*fill='#e6ab17'.*stroke-width='1.7'/);
 icon.use('night');assert.equal(attrs.href,night.waiting);
 icon.set(null);assert.equal(attrs.href,night.idle);
 icon.use('removed');assert.equal(attrs.href,morning.idle);
 assert.doesNotThrow(()=>createTabIcon(null).set('working'));
});

test('every icon set tells Waiting from Running by sky and rays',()=>{
 for(const set of tabIcons){
  const [waiting,working]=[set.waiting,set.working].map(decodeURIComponent),sky=s=>/<rect[^>]*fill='([^']+)'/.exec(s)[1];
  assert.equal(sky(waiting),sky(decodeURIComponent(set.idle)),set.id);assert.notEqual(sky(working),sky(waiting),set.id);
  assert.match(waiting,/stroke-width='1.7'/);assert.match(working,/stroke-width='2.8'/);
 }
});

test('a Root uses its own choice and falls back to the project default per field',()=>{
 const stored={theme:'dark-iris',tabIcon:'cloudy',roots:{'5':{tabIcon:'night'}}};
 assert.deepEqual(resolveAppearance(stored,'5'),{theme:'dark-iris',tabIcon:'night',custom:true});
 assert.deepEqual(resolveAppearance(stored,'6'),{theme:'dark-iris',tabIcon:'cloudy',custom:false});
 assert.deepEqual(resolveAppearance(stored,null),{theme:'dark-iris',tabIcon:'cloudy',custom:false});
});
