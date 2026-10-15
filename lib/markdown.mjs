import {marked} from 'marked';
import sanitize from 'sanitize-html';
import {parseFragment, serialize} from 'parse5';

const attribute = (node, name) => node?.attrs?.find(a => a.name === name)?.value;
function element(tagName, attrs = {}, children = []) {
  const node = {nodeName:tagName, tagName, namespaceURI:'http://www.w3.org/1999/xhtml',
    attrs:Object.entries(attrs).map(([name,value]) => ({name,value:String(value)})), childNodes:children};
  children.forEach(child => child.parentNode = node);
  return node;
}
function safeHTML(source) {
  return sanitize(marked.parse(source, {gfm:true, async:false}), {
    allowedTags:'p h1 h2 h3 h4 h5 h6 strong em b i s del u ul ol li blockquote pre code br hr a img table thead tbody tr th td details summary section div span dl dt dd'.split(' '),
    allowedAttributes:{a:['href','title'], img:['src','alt','title'], code:['class'], span:['class'], th:['align'], td:['align']},
    allowedSchemes:['http','https'], allowProtocolRelative:false,
    transformTags:{input:(tagName, attrs) => attrs.type === 'checkbox'
      ? {tagName:'span',attribs:{class:'task-box'},text:attrs.checked !== undefined ? '☑' : '☐'}
      : {tagName:'span',attribs:{},text:''}, img:(tagName, attrs) => ({tagName, attribs:/^\/api\/images\/[0-9a-f-]{36}$/.test(attrs.src || '') ? attrs : {}})},
    exclusiveFilter:frame => frame.tag === 'img' && !frame.attribs.src,
  });
}
function textOf(node) {
  if (attribute(node, 'data-annotation-ignore') !== undefined) return '';
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textOf).join('');
}
// GFM autolinks end only at whitespace, so a URL written inside Japanese text
// swallows the closing parenthesis and the words after it. Keep URL characters
// (and balanced parentheses) in the link and return the rest to the text.
const urlCharacters = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
function urlPart(text) {
  let url = urlCharacters.exec(text)?.[0] || '';
  while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
  return url.replace(/[.,;:!?]+$/, '');
}
function trimAutolinks(parent) {
  for (let i = 0; i < (parent.childNodes || []).length; i++) {
    const node = parent.childNodes[i];
    if (node.tagName !== 'a') { trimAutolinks(node); continue; }
    const text = node.childNodes?.length === 1 && node.childNodes[0].nodeName === '#text' ? node.childNodes[0].value : null;
    const href = attribute(node, 'href');
    if (!text || !href || !/^https?:\/\//.test(text) || !(href === text || decodeURI(href) === text)) continue;
    const url = urlPart(text);
    if (!url || url === text) continue;
    node.childNodes[0].value = url;
    node.attrs.find(a => a.name === 'href').value = encodeURI(url);
    const rest = {nodeName:'#text', value:text.slice(url.length), parentNode:parent};
    parent.childNodes.splice(i + 1, 0, rest);
  }
}
function prepare(source, fold) {
  const tree = parseFragment(safeHTML(source));
  trimAutolinks(tree);
  let diagram = 0;
  function diagrams(parent) {
    if (!parent.childNodes) return;
    parent.childNodes = parent.childNodes.map(node => {
      if (node.tagName === 'pre') {
        const code = node.childNodes.find(n => n.tagName === 'code');
        if (attribute(code, 'class')?.split(/\s+/).includes('language-mermaid')) {
          const figure = element('figure', {'class':'mermaid-diagram', 'data-diagram-id':diagram++,
            'data-diagram-source':textOf(code), 'data-annotation-ignore':''});
          figure.parentNode = parent;
          return figure;
        }
      }
      diagrams(node);
      return node;
    });
  }
  diagrams(tree);
  if (fold) {
    // Marked owns Markdown parsing. Only its rendered top-level headings define
    // sections; headings inside code, quotes and lists are not section boundaries.
    const stack = [{depth:1, parent:tree}], nodes = tree.childNodes;
    tree.childNodes = [];
    let section = 0;
    for (const node of nodes) {
      const depth = /^h([1-6])$/.exec(node.tagName || '')?.[1];
      if (depth) {
        while (stack.length > 1 && stack.at(-1).depth >= Number(depth)) stack.pop();
        if (Number(depth) >= 2) {
          const content = element('div', {'class':'detail-content'});
          const detail = element('details', {'class':'brief-detail', 'data-detail-id':section++},
            [element('summary', {}, [node]), content]);
          stack.at(-1).parent.childNodes.push(detail);
          stack.push({depth:Number(depth), parent:content});
          continue;
        }
        stack.splice(1);
      }
      stack.at(-1).parent.childNodes.push(node);
    }
  }
  return tree;
}
export const markdownHTML = source => serialize(prepare(source, true));
// One annotation coordinate system: rendered text, including collapsed sections,
// excluding diagram internals. It is independent of HTML wrappers and SVG output.
export const markdownText = source => textOf(prepare(source, false));
export const renderedEvent = event => ({...event, html:markdownHTML(event.text || '')});
