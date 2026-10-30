import sanitize from 'sanitize-html';
import {parse, parseFragment, serialize, serializeOuter} from 'parse5';
import {markdownHTML, markdownText} from './markdown.mjs';

export function validBriefFormat(format) {
  if(!['markdown','html'].includes(format))throw new Error('Deliverable format must be markdown or html.');
  return format;
}
function htmlParts(source) {
  const tree=parse(source),html=tree.childNodes.find(n=>n.tagName==='html');
  const head=html.childNodes.find(n=>n.tagName==='head'),body=html.childNodes.find(n=>n.tagName==='body');
  // Keep author CSS inside the isolated document, never in the workspace page.
  const styles=[];
  function collect(node) {if(node.tagName==='style')styles.push(node.childNodes.map(n=>n.value||'').join(''));else (node.childNodes||[]).forEach(collect);}
  collect(head);collect(body);
  const clean=sanitize(source,{
    allowedTags:[...sanitize.defaults.allowedTags,'details','summary','img','svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','marker','title','desc'],
    allowedAttributes:{'*':['class','id','style','role','aria-label','aria-hidden'],a:['href','title'],details:['open'],img:['src','alt','title','width','height'],
      svg:['viewBox','width','height','xmlns'],g:['transform','fill','stroke','stroke-width'],path:['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin'],
      rect:['x','y','width','height','rx','fill','stroke','stroke-width'],circle:['cx','cy','r','fill','stroke','stroke-width'],ellipse:['cx','cy','rx','ry','fill','stroke','stroke-width'],
      line:['x1','y1','x2','y2','stroke','stroke-width','marker-end'],polyline:['points','fill','stroke','stroke-width'],polygon:['points','fill','stroke','stroke-width'],
      text:['x','y','fill','text-anchor','font-size','font-weight'],tspan:['x','y','dx','dy'],marker:['id','markerWidth','markerHeight','refX','refY','orient','markerUnits'],th:['colspan','rowspan'],td:['colspan','rowspan']},
    parser:{lowerCaseTags:false,lowerCaseAttributeNames:false},
    nonTextTags:['script','style','textarea','option','head'],allowedSchemes:['http','https'],allowProtocolRelative:false,
    transformTags:{svg:(tagName,attrs)=>({tagName,attribs:{...attrs,'data-annotation-ignore':''}}),
      img:(tagName,attrs)=>({tagName,attribs:/^\/api\/images\/[0-9a-f-]{36}$/.test(attrs.src||'')?attrs:{}})},
    exclusiveFilter:frame=>frame.tag==='img'&&!frame.attribs.src,
  });
  return {body:clean,styles};
}
// A Deliverable with no layout at all reads like Markdown in HTML. Publishing still
// succeeds; the hint only points at a visual-first page. Tag and keyword presence is enough.
const layout=/<(table|svg|img)\b|display\s*:\s*(inline-)?(grid|flex)\b/i;
const visualFirst='diagrams (inline SVG), tables, the current and finished form side by side.';
export function briefLayoutHint(source,format='markdown') {
  if(!source.trim())return null;
  if(validBriefFormat(format)==='markdown')return `This is Markdown. Make it a visual-first HTML page: ${visualFirst}`;
  return layout.test(source)?null:`This reads like Markdown in HTML. Make it a visual-first page: ${visualFirst}`;
}
export function briefHTML(source,format='markdown') {
  return validBriefFormat(format)==='html'?htmlParts(source).body:markdownHTML(source);
}
export function briefText(source,format='markdown') {
  if(validBriefFormat(format)==='markdown')return markdownText(source);
  function text(node) {
    if(node.tagName==='svg')return '';
    return node.nodeName==='#text'?node.value:(node.childNodes||[]).map(text).join('');
  }
  return text(parseFragment(htmlParts(source).body));
}
// CLI reading uses paragraph boundaries; annotation offsets still use briefText.
export function briefReadableText(source,format='markdown') {
  if(validBriefFormat(format)==='markdown')return source;
  const blocks=new Set('p h1 h2 h3 h4 h5 h6 ul ol li blockquote pre table tr div section article details summary dl dt dd'.split(' '));
  function read(node) {
    if(node.tagName==='svg')return '';
    if(node.nodeName==='#text')return node.value;
    if(node.tagName==='br')return '\n';
    const content=(node.childNodes||[]).map(read).join('');
    if(['td','th'].includes(node.tagName))return content+' | ';
    return blocks.has(node.tagName)?'\n'+content+'\n':content;
  }
  return read(parseFragment(htmlParts(source).body)).replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function svgNodes(tree) {
  return (tree.childNodes||[]).flatMap(node=>node.tagName==='svg'?[node]:svgNodes(node));
}
// Index only the sanitized, authored SVGs. Annotation controls added by Web
// never change this version-local identity.
export function briefSVG(source,index) {
  if(!Number.isSafeInteger(index)||index<0)return null;
  const {body,styles}=htmlParts(source),svg=svgNodes(parseFragment(body))[index];
  if(!svg)return null;
  if(!svg.attrs.some(a=>a.name==='xmlns'))svg.attrs.push({name:'xmlns',value:'http://www.w3.org/2000/svg'});
  const css=styles.join('\n').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  return serializeOuter(svg).replace(/<svg\b[^>]*>/,open=>`${open}<style>${css}</style>`);
}
export function briefDocument(source) {
  const {body:content,styles}=htmlParts(source),tree=parseFragment(content);
  svgNodes(tree).forEach((svg,index)=>svg.attrs.push({name:'data-brief-svg',value:String(index)}));
  const body=serialize(tree);
  const css=styles.join('\n').replace(/<\/style/gi,'<\\/style');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{overflow:hidden}body{margin:0;padding:clamp(18px,calc(15.43px + .66vw),24px) clamp(16px,calc(11.71px + 1.1vw),26px)}*,*::before,*::after{box-sizing:border-box}img{max-width:100%;height:auto}${css}\n.annotation-mark{background:#d9eab0!important;border-radius:3px;cursor:pointer}.annotation-mark.is-draft{background:#ebefbc!important}.annotation-mark.is-editing{outline:1px dashed #658663}svg{user-select:none}.annotation-action{position:absolute;z-index:2147483647;width:44px;height:44px;padding:0;display:grid;place-items:center;border:1px solid #006f66;border-radius:50%;background:#006f66;color:white;box-shadow:0 4px 15px #0003;cursor:pointer}.annotation-action[hidden]{display:none}.annotation-action svg{width:20px;height:20px;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.annotation-key-hint{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);display:none;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;background:#243b3e;color:#fff;font:600 12px system-ui,-apple-system,sans-serif;white-space:nowrap;pointer-events:none}.annotation-key-hint::after{content:"";position:absolute;top:100%;left:50%;margin-left:-5px;border:5px solid transparent;border-top-color:#243b3e}.annotation-key-hint kbd{min-width:16px;padding:0 5px;border:1px solid #ffffff80;border-bottom-width:2px;border-radius:4px;background:#ffffff1a;font:700 12px ui-monospace,monospace;text-align:center}@media (hover:hover){.annotation-action:hover .annotation-key-hint{display:inline-flex}}.annotatable-image{position:relative;display:inline-block;max-width:100%;vertical-align:middle}.annotatable-image img{display:block;max-width:100%;height:auto;user-select:none}.image-annotate{position:absolute;z-index:1;top:8px;right:8px;width:44px;height:44px;display:grid;place-items:center;border:1px solid #909a92;border-radius:50%;color:#35443a;background:white;cursor:pointer}.image-annotate svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.annotatable-image>svg{display:block;max-width:100%;height:auto}.annotatable-image.is-fluid{display:block}.annotatable-image.is-fluid>svg,.annotatable-image.is-fluid>img{width:100%}.annotatable-image:has(.image-annotate){cursor:zoom-in}.image-note-box{position:absolute;padding:0;border:2px solid #658663;border-radius:3px;background:#43d3c426;cursor:pointer}.image-note-box.is-draft{border-style:dashed}.code-block{position:relative}.code-block>pre{padding-right:52px}.code-copy{position:absolute;top:4px;right:4px;min-width:36px;height:36px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid #d3dbd4;border-radius:6px;background:#fffffff0;color:#4a5a4f;font:600 12px system-ui,-apple-system,sans-serif;cursor:pointer}.code-copy:hover{background:#f2f5f1}.code-copy svg{width:16px;height:16px;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.code-copy[data-copied] svg{display:none}.code-copy[data-copied=done]{color:#267653;border-color:#b3d9b8}.code-copy[data-copied=done]::after{content:"\\2713  Copied"}.code-copy[data-copied=failed]{color:#ae6128}.code-copy[data-copied=failed]::after{content:"Copy failed"}</style></head><body><div class="brief-body">${body}</div></body></html>`;
}

// Agents see the Deliverable by that name; stored annotations keep the internal one.
export const agentAnnotations=notes=>Array.isArray(notes)?notes.map(n=>n?.source?.kind==='brief'?{...n,source:{...n.source,kind:'deliverable'}}:n):notes;
