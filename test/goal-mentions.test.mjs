import test from 'node:test';
import assert from 'node:assert/strict';
import {goalMentions} from '../lib/goal-mentions.mjs';

const comment = (id, goalId, text, extra = {}) => ({id, goalId, text, updatedAt:`2026-10-19T00:00:${String(id).padStart(2, '0')}Z`, ...extra});

test('a Goal lists each other visible Goal that names it once, at its first mention', () => {
  const mentions = goalMentions([
    comment(4, '2', 'again #1'),
    comment(3, '2', 'see #1 and #3'),
    comment(5, '1', 'my own #1'),
    comment(6, '3', '`#1` in code'),
    comment(7, '4', 'hidden Goal names #1'),
    comment(8, '3', 'removed #1', {deletedAt:'2026-10-19T01:00:00Z'}),
  ], new Set(['1', '2', '3']));
  assert.deepEqual(mentions.get('1'), [{goalId:'2', eventId:3, at:'2026-10-19T00:00:03Z'}]);
  assert.deepEqual(mentions.get('3'), [{goalId:'2', eventId:3, at:'2026-10-19T00:00:03Z'}]);
  assert.equal(mentions.has('2'), false);
});
