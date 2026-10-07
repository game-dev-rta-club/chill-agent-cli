let library;
export async function renderDiagrams(root) {
  const targets = [...root.querySelectorAll('.mermaid-diagram:not([data-rendered])')]
    .filter(el => el.getClientRects().length && !el.closest('details:not([open])'));
  if (!targets.length) return;
  library ??= import('/vendor/mermaid.js').then(({default:mermaid}) => {
    mermaid.initialize({startOnLoad:false, securityLevel:'strict', htmlLabels:false, suppressErrorRendering:true});
    return mermaid;
  });
  let mermaid;
  try {mermaid = await library;} catch {library = null;}
  for (const el of targets) {
    if (el.dataset.rendered || !el.isConnected) continue;
    el.dataset.rendered = 'pending';
    try {
      if (!mermaid) throw new Error('Diagram renderer unavailable');
      const {svg} = await mermaid.render(`diagram-${crypto.randomUUID()}`, el.dataset.diagramSource);
      if (!el.isConnected) continue;
      const template=document.createElement('template'); template.innerHTML=svg;
      template.content.querySelectorAll('style').forEach(style => style.setAttribute('nonce',document.querySelector('meta[name="style-nonce"]').content));
      const diagram=template.content.querySelector('svg');
      const width=Number(diagram?.getAttribute('viewBox')?.split(/\s+/)[2]);
      if(width>0)diagram.style.maxWidth=`${width}px`;
      el.replaceChildren(template.content); el.dataset.rendered = 'ready';
      el.setAttribute('role','img'); el.setAttribute('aria-label','Mermaid diagram');
    } catch {
      if (!el.isConnected) continue;
      const label = document.createElement('p'); label.textContent = 'Could not display this diagram.';
      const code = document.createElement('pre'); code.textContent = el.dataset.diagramSource;
      el.replaceChildren(label, code); el.dataset.rendered = 'error';
    }
  }
}
export function annotationTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode:node => node.parentElement?.closest('[data-annotation-ignore], svg, style, script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = []; let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}
export function annotationOffset(root, node, offset) {
  const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, offset);
  return annotationTextNodes(range.cloneContents()).reduce((sum, text) => sum + text.length, 0);
}
