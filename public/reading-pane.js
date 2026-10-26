// Own the page's programmatic scroll changes. Menus scroll inside their own panels.
// On a wide screen the Conversation column scrolls by itself ([data-scroll-pane]);
// the same rules then apply inside that column.
export function createReadingPane(pane, {rectOf = el => el.getBoundingClientRect()} = {}) {
  let interaction = 0, preferred = null;
  const interrupt = () => { interaction++; preferred = null; };
  const setTop = top => { interrupt(); pane.scrollTop = top; };
  const anchors = '#timeline-list > *, .conversation-form';
  // A nested pane counts only while its layout actually scrolls it.
  const scrolls = el => el !== pane && getComputedStyle(el).overflowY !== 'visible';
  const nested = () => [...pane.querySelectorAll('[data-scroll-pane]')].filter(scrolls);
  const containerOf = target => { const own = target?.closest?.('[data-scroll-pane]'); return own && pane.contains(own) && scrolls(own) ? own : pane; };
  // The sticky composer covers the bottom of a scrolling Conversation column.
  const coveredBottom = container => {
    const form = container === pane ? null : container.querySelector(':scope > .conversation-form, .conversation-form');
    return form && getComputedStyle(form).position === 'sticky' ? form.offsetHeight : 0;
  };
  function captureIn(container) {
    const top = container.scrollTop, bounds = container.getBoundingClientRect();
    // A Conversation read at its very end keeps showing the newest lines, in its
    // own column or, on a narrow screen, at the end of the page. A page not yet
    // scrolled stays at its top while it loads.
    const atEnd = (container !== pane || top > 0) && top + container.clientHeight >= container.scrollHeight - 2;
    const owner = pane.firstElementChild, revision = interaction;
    const inView = el => {
      if(!el?.isConnected)return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    };
    const visible = top > 0 ? [...container.querySelectorAll(anchors)].filter(el => containerOf(el) === container && inView(el)) : [];
    const destination = preferred?.id ? container.querySelector(`#${CSS.escape(preferred.id)}`) : preferred;
    // A visible message boundary is more stable than the tail of growing Activity.
    // An explicit destination stays the anchor until the reader moves again.
    const anchor = inView(destination) && containerOf(destination) === container ? destination
      : visible.find(el => el.getBoundingClientRect().top >= bounds.top) || visible[0];
    const offset = anchor?.getBoundingClientRect().top;
    const id = anchor?.id, first = anchor?.dataset.gapFirst, last = anchor?.dataset.gapLast;
    const nestedIndex = container === pane ? -1 : nested().indexOf(container);
    return () => {
      if (owner !== pane.firstElementChild || revision !== interaction) return;
      // A re-rendered column is a new element; find it again by position.
      const target = container === pane ? pane : container.isConnected ? container : nested()[nestedIndex];
      if (!target) return;
      if (atEnd) { target.scrollTop = target.scrollHeight; return; }
      const retained = id ? target.querySelector(`#${CSS.escape(id)}`) : first
        ? target.querySelector(`[data-gap-first="${first}"][data-gap-last="${last}"]`) : anchor;
      // Content below the viewport never becomes an anchor. Entry stays at zero.
      target.scrollTop = top === 0 ? 0 : retained?.isConnected
        ? target.scrollTop + retained.getBoundingClientRect().top - offset : top;
    };
  }
  function capture() {
    const restores = [pane, ...nested()].map(captureIn);
    return () => { for (const restore of restores) restore(); };
  }
  function preserve(change) {
    const restore = capture();
    change();
    restore();
  }
  function align(target, viewportTop) {
    if (!target?.isConnected) return;
    interrupt();
    const container = containerOf(target);
    preferred = target.closest(anchors) || (pane.contains(target) ? target : null);
    container.scrollTop += rectOf(target).top - viewportTop;
  }
  function reveal(target, block = 'center') {
    if (!target?.isConnected) return;
    interrupt();
    const container = containerOf(target);
    preferred = target.closest(anchors) || (pane.contains(target) ? target : null);
    // scrollIntoView can also move overflow:hidden ancestors and the fixed shell.
    const rect = rectOf(target), bounds = container.getBoundingClientRect();
    const top = bounds.top + container.clientTop + 12, bottom = top + container.clientHeight - 24 - coveredBottom(container);
    if (block === 'start' || (block === 'center' && rect.bottom - rect.top > bottom - top))
      container.scrollTop += rect.top - top;
    else if (block === 'center') container.scrollTop += (rect.top + rect.bottom - top - bottom) / 2;
    else if (rect.top >= top && rect.bottom <= bottom || rect.top < top && rect.bottom > bottom) return;
    else container.scrollTop += rect.top < top ? rect.top - top : rect.bottom - bottom;
  }
  // Show the newest message of a scrolling Conversation column when a Goal opens.
  function showLatest() {
    for (const column of nested()) column.scrollTop = column.scrollHeight;
  }
  return {capture, preserve, align, reveal, setTop, showLatest, interrupt, get interaction() { return interaction; }};
}
