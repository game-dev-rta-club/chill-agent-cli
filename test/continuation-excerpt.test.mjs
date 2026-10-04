import test from 'node:test';
import assert from 'node:assert/strict';
import {continuationExcerpt as excerpt} from '../lib/continuation-excerpt.mjs';
test('recall excerpts stop at a sentence and mark omission without cutting Unicode',()=>{
 assert.equal(excerpt('設定をRefreshしました。次に残った仕事を確認して進めます。',20),'設定をRefreshしました。…');
 assert.equal(excerpt('Done. Another long explanation follows.',16),'Done.…');
 assert.equal(excerpt('短い\n文章'),'短い 文章');
 const emoji=excerpt('😀'.repeat(20),10);assert.equal(Array.from(emoji).length,10);assert.equal(emoji,'😀'.repeat(9)+'…');
 assert.equal(excerpt(excerpt('設定をRefreshしました。次に残った仕事を確認して進めます。',20),20),'設定をRefreshしました。…');
});
