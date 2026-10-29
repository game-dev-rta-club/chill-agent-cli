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
  addCodeCopy(template.content);
  return template.innerHTML;
}

// Each code block gets a Copy button at its top right. The button holds no
// text, so the text offsets annotations count stay the same.
const copyIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
export function addCodeCopy(root) {
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement?.classList.contains('code-block')) return;
    const doc = pre.ownerDocument, block = doc.createElement('div'), button = doc.createElement('button');
    block.className = 'code-block';
    button.type = 'button'; button.className = 'code-copy'; button.dataset.action = 'copy-code';
    button.title = 'Copy'; button.setAttribute('aria-label', 'Copy code'); button.innerHTML = copyIcon;
    pre.replaceWith(block); block.append(pre, button);
  });
}
// The page may be opened over plain http from a phone, where navigator.clipboard
// is missing; a hidden text area and execCommand still copy there.
async function writeText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}
export async function copyCode(button) {
  const copied = await writeText(button.closest('.code-block')?.querySelector('pre')?.textContent ?? '');
  button.dataset.copied = copied ? 'done' : 'failed'; button.title = copied ? 'Copied' : 'Copy failed';
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { delete button.dataset.copied; button.title = 'Copy'; }, 2000);
}
