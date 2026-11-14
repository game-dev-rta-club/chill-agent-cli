import test from 'node:test';
import assert from 'node:assert/strict';
import {referencePreviewMarkup} from '../public/reference-preview.js';

const link = dataset => ({dataset});
const goals = {'144': {title: 'Old <format>', state: 'waiting'}, '12': {title: 'Open', state: 'idle'}};
const goal = id => goals[id];

test('a Goal link previews its title and state at once', () => {
  assert.match(referencePreviewMarkup(link({goal: '144'}), {goal}), /Goal #144 · Waiting<\/span><span>Old &lt;format&gt;<\/span>/);
  assert.match(referencePreviewMarkup(link({goal: '12'}), {goal}), /Goal #12<\/span><span>Open/);
  assert.equal(referencePreviewMarkup(link({goal: '99'}), {goal}), '', 'a Goal the page does not have shows nothing');
});

test('a comment link previews who wrote it, when and its first line; a Letter its question', () => {
  const comment = {type: 'comment', author: 'agent', updatedAt: '2026-11-14T08:20:00.000Z', text: '\n実装して PR を出しました。\n詳細'};
  assert.match(referencePreviewMarkup(link({goal: '187', number: '9'}), {goal, event: comment}), /Goal #187 comment 9 · Agent · .*<span>実装して PR を出しました。<\/span>$/);
  const letter = {type: 'letter', author: 'agent', title: '進めてよいか', updatedAt: '2026-11-14T08:20:00.000Z', text: 'body'};
  assert.match(referencePreviewMarkup(link({goal: '187', number: '3'}), {goal, event: letter}), /Goal #187 Letter 3 · Agent .*<span>進めてよいか<\/span>/, 'Letter or comment follows what the number is');
  assert.match(referencePreviewMarkup(link({goal: '187', number: '99'}), {goal, event: null}), /Not found/);
});
