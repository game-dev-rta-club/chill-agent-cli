import test from 'node:test';
import assert from 'node:assert/strict';
import {returnedDocument} from '../scripts/claude-probe-evidence.mjs';
const document='# Guide\n\nRead the current agreement.\n';
function messages(name,content,error=false){return [{message:{content:[{type:'tool_use',id:'read-1',name,input:{file_path:'/guide.md'}}]}},{message:{content:[{type:'tool_result',tool_use_id:'read-1',content,is_error:error}]}}];}
test('probe recognizes full native Read output while preserving source indentation',()=>{
  assert(returnedDocument(messages('Read','     1→# Guide\n     2→\n     3→Read the current agreement.\n'),document));
  assert(returnedDocument(messages('Read','1\t# Guide\n2\t\n3\tRead the current agreement.\n'),document));
  assert(returnedDocument(messages('Bash',document),document));
  assert(returnedDocument(messages('Read',[{type:'text',text:'1→  indented\n2→    code'}]),'  indented\n    code'));
});
test('a path, partial return, failed read or claimed read is not full-document evidence',()=>{
  assert(!returnedDocument(messages('Read','/guide.md'),document));
  assert(!returnedDocument(messages('Read','1→# Guide'),document));
  assert(!returnedDocument(messages('Read',document,true),document));
  assert(!returnedDocument([{message:{content:'I read /guide.md'}}],document));
  assert(!returnedDocument(messages('Bash','1→# Guide\n2→\n3→Read the current agreement.'),document));
});
