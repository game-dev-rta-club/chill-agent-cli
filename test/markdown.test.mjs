import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFragment} from 'parse5';
import {markdownHTML,markdownText} from '../lib/markdown.mjs';
const textOf=n=>n.nodeName==='#text'?n.value:(n.childNodes||[]).map(textOf).join('');
const nodes=(n,tag)=>[...(n.tagName===tag?[n]:[]),...(n.childNodes||[]).flatMap(c=>nodes(c,tag))];
test('Markdown renders GFM and creates initially closed, nested heading sections',()=>{
 const source='# Outcome\n\n**Shared** opening.\n\n## A\n\n- first\n- second\n\n### Deep\n\n| Item | State |\n| --- | --- |\n| A | Ready |\n\n#### Deeper\n\n`inline`\n\n## B\n\n~~~js\n## not a heading\n~~~\n\n# Another\n\nVisible again.';
 const html=markdownHTML(source),tree=parseFragment(html),details=nodes(tree,'details');
 assert.equal(details.length,4);assert.ok(details.every(d=>!d.attrs.some(a=>a.name==='open')));
 assert.equal(nodes(details[0],'details').length,3);assert.equal(nodes(details[3],'details').length,1);
 assert.equal(nodes(tree,'table').length,1);assert.equal(nodes(tree,'li').length,2);assert.match(html,/<strong>Shared<\/strong>/);
 assert.match(html,/<code class="language-js">## not a heading/);
 assert.equal(markdownText(source),textOf(tree),'folding does not change annotation coordinates');
 assert.equal(nodes(tree,'h1').length,2);assert.equal(tree.childNodes.at(-2).tagName,'p');
});
test('Skipped heading levels and headings inside quotes stay correctly scoped',()=>{
 const tree=parseFragment(markdownHTML('Intro\n\n## A\n\n#### Child\n\nOne\n\n### Peer\n\nTwo\n\n> ## quoted\n\n## B\n\nEnd'));
 const details=nodes(tree,'details');assert.equal(details.length,4);
 assert.equal(nodes(details[0],'details').length,3);assert.equal(nodes(details[1],'details').length,1);
 assert.equal(nodes(tree,'blockquote').length,1);
});
test('Mermaid is encoded as inert source and excluded from annotation coordinates',()=>{
 const source='Before\n\n```mermaid\ngraph TD\n A["<script>alert(1)</script>"] --> B\n```\n\n**After**';
 const tree=parseFragment(markdownHTML(source)),figure=nodes(tree,'figure')[0];
 assert.equal(figure.attrs.find(a=>a.name==='data-diagram-source').value,'graph TD\n A["<script>alert(1)</script>"] --> B\n');
 assert.equal(nodes(tree,'script').length,0);assert.equal(figure.childNodes.length,0);
 assert.equal(markdownText(source),textOf(tree));assert.match(markdownText(source),/Before[\s\S]*After/);
});
test('Active HTML and unsafe links are filtered; Markdown code remains literal',()=>{
 const html=markdownHTML('<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n<img src="https://other/image" onerror="alert(1)">\n\n```html\n<script>literal</script>\n```');
 assert.doesNotMatch(html,/<script|javascript:|onerror|<img/);assert.match(html,/&lt;script&gt;literal/);
});

test('Task lists retain completion as static marks without form controls',()=>{
 const html=markdownHTML('- [x] Done\n- [ ] To do');
 assert.match(html,/☑/);assert.match(html,/☐/);assert.doesNotMatch(html,/<input/);
 assert.equal(markdownText('- [x] Done\n- [ ] To do'),textOf(parseFragment(html)));
});
