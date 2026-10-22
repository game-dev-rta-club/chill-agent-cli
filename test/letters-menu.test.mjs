import test from 'node:test';
import assert from 'node:assert/strict';
import {waitingMessages} from '../public/letters-menu.js';
test('header Letters include descendants, exclude other roots and answered or received Letters',()=>{
 const goals=[{id:'1'},{id:'2',parentId:'1'},{id:'3'}];
 const letter=(id,goalId,extra={})=>({id,goalId,author:'agent',type:'letter',...extra});
 const events=[letter(1,'1'),letter(2,'2'),letter(3,'3'),letter(4,'2',{receivedAt:'today'}),letter(5,'1'),{id:6,goalId:'1',author:'user',annotations:[{kind:'letter',source:{kind:'comment',eventId:5}}]}];
 const letters=(...args)=>waitingMessages(...args).letters.map(e=>e.id);
 assert.deepEqual(letters(goals,events,'2'),[1,2]);
 assert.deepEqual(letters(goals,events,null),[1,2,3]);
 assert.deepEqual(letters(goals,[],null),[]);
});
test('header Replies list notified replies newer than their Goal read mark, apart from Letters',()=>{
 const goals=[{id:'1',readThrough:10,notified:[11,13]},{id:'2',parentId:'1',readThrough:20,notified:[21]},{id:'3',readThrough:0,notified:[31]}];
 const reply=(id,goalId,extra={})=>({id,goalId,author:'agent',type:'comment',text:'Result',...extra});
 const events=[reply(9,'1'),reply(11,'1'),reply(12,'1'),reply(13,'1',{deletedAt:'now'}),reply(21,'2'),reply(31,'3'),{id:14,goalId:'1',author:'agent',type:'letter'}];
 const {letters,replies}=waitingMessages(goals,events,'2');
 assert.deepEqual(replies.map(e=>e.id),[11,21],'only notified, unread, not deleted, same Root');
 assert.deepEqual(letters.map(e=>e.id),[14]);
});
