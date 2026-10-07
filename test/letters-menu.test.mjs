import test from 'node:test';
import assert from 'node:assert/strict';
import {openLetters} from '../public/letters-menu.js';
test('header Letters include descendants, exclude other roots and answered or received Letters',()=>{
 const goals=[{id:'1'},{id:'2',parentId:'1'},{id:'3'}];
 const letter=(id,goalId,extra={})=>({id,goalId,author:'agent',type:'letter',...extra});
 const events=[letter(1,'1'),letter(2,'2'),letter(3,'3'),letter(4,'2',{receivedAt:'today'}),letter(5,'1'),{id:6,goalId:'1',author:'user',annotations:[{kind:'letter',source:{kind:'comment',eventId:5}}]}];
 assert.deepEqual(openLetters(goals,events,'2').map(e=>e.id),[1,2]);
 assert.deepEqual(openLetters(goals,events,null).map(e=>e.id),[1,2,3]);
 assert.deepEqual(openLetters(goals,[],null),[]);
});
