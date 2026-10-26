// HTML is parsed and filtered on the server. Restore only disclosure state here.
export function briefBody(html, {hasGoal, replyId = null, opened = new Set()}) {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('a[data-goal]').forEach(link => { if (!hasGoal(link.dataset.goal)) link.replaceWith(link.textContent); });
  template.content.querySelectorAll('a[href]').forEach(link => {
    // A link that is not a valid URL stays as text; it must not stop the page.
    // Read the written href: inside a template, link.href resolves against
    // about:blank, so #/goal/N would look like another site and open a new tab.
    let origin = null;
    try { origin = new URL(link.getAttribute('href'), location.href).origin; } catch { link.removeAttribute('href'); return; }
    if (origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  template.content.querySelectorAll('details').forEach((el, i) => {
    el.className = 'brief-detail'; el.dataset.detailId = String(i);
    if (replyId !== null) {
      el.classList.add('reply-detail');
      el.dataset.replyDetail = `${replyId}:${i}`; delete el.dataset.detailId;
      el.open = opened.has(el.dataset.replyDetail);
    }
    if (!el.querySelector(':scope > .detail-content')) {
      const content = document.createElement('div'); content.className = 'detail-content';
      for (const child of [...el.childNodes]) if (child.nodeType !== 1 || child.localName !== 'summary') content.append(child);
      el.append(content);
    }
  });
  return template.innerHTML;
}
