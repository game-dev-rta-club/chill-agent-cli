// The small box a reference link shows while the pointer rests on it, so the
// user can tell what it names without opening it: #12 shows the Goal's title
// and state at once; C3 or L4 loads the comment or Letter once and shows who
// wrote it, when, and its first line. The heading spells the reference out
// (Goal #187 comment 3), so the short form reads plainly. Only where a pointer can hover.
import {escapeHTML} from './goal-view.js';

const stateLabels = {done: 'Done', waiting: 'Waiting'};
const firstLine = text => { const line = String(text || '').split('\n').map(part => part.trim()).find(Boolean) || ''; return line.length > 140 ? `${line.slice(0, 140)}…` : line; };
const when = at => new Date(Date.parse(at)).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

// goal(id) gives a Goal the page has; fetchNumber(goalId, number) the event, or null.
export function referencePreviewMarkup(link, {goal, event}) {
  const goalId = link.dataset.goal, number = link.dataset.number, meta = text => `<span class="reference-preview-meta">${escapeHTML(text)}</span>`;
  if (!number) { const found = goal(goalId); return found ? `${meta(`Goal #${goalId}${stateLabels[found.state] ? ` · ${stateLabels[found.state]}` : ''}`)}<span>${escapeHTML(found.title)}</span>` : ''; }
  if (!event) return `${meta(`Goal #${goalId} comment ${number}`)}<span>Not found in this Goal.</span>`;
  const ref = `${event.type === 'letter' ? 'Letter' : 'comment'} ${number}`, author = event.author === 'agent' ? 'Agent' : 'You';
  return `${meta(`Goal #${goalId} ${ref} · ${author} · ${when(event.createdAt || event.updatedAt)}`)}<span>${escapeHTML(event.type === 'letter' && event.title ? event.title : firstLine(event.text))}</span>`;
}

export function createReferencePreview({root, goal, fetchNumber}) {
  if (!window.matchMedia?.('(hover: hover)').matches) return;
  const box = document.createElement('div'), events = new Map();
  box.className = 'reference-preview'; box.hidden = true; box.setAttribute('role', 'tooltip');
  document.body.append(box);
  let current = null, timer = null;
  const hide = () => { clearTimeout(timer); current = null; box.hidden = true; };
  function load(goalId, number) {
    const key = `${goalId}/${number}`;
    if (!events.has(key)) events.set(key, fetchNumber(goalId, number).catch(() => null).then(event => { if (!event) events.delete(key); return event; }));
    return events.get(key);
  }
  async function show(link) {
    const event = link.dataset.number ? await load(link.dataset.goal, link.dataset.number) : null;
    const html = current === link && referencePreviewMarkup(link, {goal, event});
    if (!html) return;
    box.innerHTML = html; box.hidden = false;
    const rect = link.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${rect.bottom + box.offsetHeight + 12 > innerHeight ? rect.top - box.offsetHeight - 6 : rect.bottom + 6}px`;
  }
  root.addEventListener('pointerover', event => {
    const link = event.target.closest?.('a[data-goal]');
    if (!link || link === current) return;
    hide(); current = link;
    timer = setTimeout(() => void show(link), 250);
  });
  root.addEventListener('pointerout', event => { const link = event.target.closest?.('a[data-goal]'); if (link && !link.contains(event.relatedTarget)) hide(); });
  root.addEventListener('click', hide);
  window.addEventListener('scroll', hide, true);
}
