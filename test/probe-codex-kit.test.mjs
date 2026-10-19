import test from 'node:test';
import assert from 'node:assert/strict';
import {shapeDiff, shapeOf} from '../scripts/probe-codex-kit.mjs';

// scripts/probe-codex.mjs lists the fake Codex's differences with this; a wrong diff would hide a real one.
test('shapeDiff names where two answers differ in keys and types, and ignores values and array length', () => {
  const real = shapeOf({data: [{id: 'a', items: [1, 2], path: '/x', status: {type: 'idle'}}], nextCursor: null, backwardsCursor: 'c'});
  assert.deepEqual(shapeDiff(real, shapeOf({data: [{id: 'zzz', items: [], path: '/y', status: {type: 'active'}}, {id: 'b', items: [3], path: 'q', status: {type: 'idle'}}], nextCursor: null, backwardsCursor: 'd'})), []);
  assert.deepEqual(shapeDiff(real, shapeOf({data: [{id: 'a', items: [1], status: {type: 5}}], nextCursor: 'x', fakeOnly: true})), [
    '$.data[].path: only in real', '$.data[].status.type: real string, fake number', '$.nextCursor: real null, fake string', '$.backwardsCursor: only in real', '$.fakeOnly: only in fake']);
});
