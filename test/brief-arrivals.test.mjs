import assert from 'node:assert/strict';
import test from 'node:test';
import {createBriefArrivalTracker} from '../public/brief-navigation.js';
test('latest updates stay announced after automatic display until dismissed',()=>{
 const arrival=createBriefArrivalTracker();
 assert.equal(arrival('1',4,4),false);
 assert.equal(arrival('1',4,5),true);
 assert.equal(arrival('1',5,5),true);
 arrival.dismiss();assert.equal(arrival('1',5,5),false);
 assert.equal(arrival('1',5,7),true);assert.equal(arrival('1',7,7),true);
});
test('historical browsing does not trigger latest-following notifications',()=>{
 const arrival=createBriefArrivalTracker();
 assert.equal(arrival('1',1,4),false);
 assert.equal(arrival('1',1,5),false);
 assert.equal(arrival('1',5,5),false);
 assert.equal(arrival('1',5,6),true);
});
test('new visits and empty Briefs use the current version as baseline',()=>{
 const arrival=createBriefArrivalTracker();
 assert.equal(arrival('1',0,0),false);assert.equal(arrival('1',0,1),true);
 assert.equal(arrival('2',2,2),false);assert.equal(arrival('1',1,1),false);
 assert.equal(arrival('1',1,2),true);assert.equal(arrival(null,null,0),false);
 assert.equal(arrival('1',1,2),false);
});
