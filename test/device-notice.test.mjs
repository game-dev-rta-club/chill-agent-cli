import test from 'node:test';
import assert from 'node:assert/strict';
import {newDeviceToShow} from '../public/device-notice.js';

test('a page announces a device that connected after it last looked, once',()=>{
 const phone={device:'iPhone · Safari',connectedAt:'2026-10-26T07:01:00.000Z'};
 assert.equal(newDeviceToShow(phone,null),null,'a browser opening the page for the first time takes it as seen');
 assert.equal(newDeviceToShow(phone,phone.connectedAt),null,'already announced');
 assert.deepEqual(newDeviceToShow(phone,'2026-10-26T07:00:00.000Z'),phone);
 assert.equal(newDeviceToShow(null,'2026-10-26T07:00:00.000Z'),null);
});
