// Own the page's programmatic scroll changes. Menus scroll inside their own panels.
export function createReadingPane(pane, {rectOf = el => el.getBoundingClientRect()} = {}) {
  let interaction = 0, preferred = null;
  const interrupt = () => { interaction++; preferred = null; };
  const setTop = top => { interrupt(); pane.scrollTop = top; };
  function capture() {
    const top = pane.scrollTop, bounds = pane.getBoundingClientRect();
    const owner = pane.firstElementChild, revision = interaction;
    const inView = el => {
      if(!el?.isConnected)return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    };
    const visible = top > 0 ? [...pane.querySelectorAll('#timeline-list > *, .conversation-form')].filter(inView) : [];
    const destination = preferred?.id ? pane.querySelector(`#${CSS.escape(preferred.id)}`) : preferred;
    // A visible message boundary is more stable than the tail of growing Activity.
    // An explicit destination stays the anchor until the reader moves again.
    const anchor = inView(destination) ? destination
      : visible.find(el => el.getBoundingClientRect().top >= bounds.top) || visible[0];
    const offset = anchor?.getBoundingClientRect().top;
    const id = anchor?.id, first = anchor?.dataset.gapFirst, last = anchor?.dataset.gapLast;
    return () => {
      if (owner !== pane.firstElementChild || revision !== interaction) return;
      const retained = id ? pane.querySelector(`#${CSS.escape(id)}`) : first
        ? pane.querySelector(`[data-gap-first="${first}"][data-gap-last="${last}"]`) : anchor;
      // Content below the viewport never becomes an anchor. Entry stays at zero.
      pane.scrollTop = top === 0 ? 0 : retained?.isConnected
        ? pane.scrollTop + retained.getBoundingClientRect().top - offset : top;
    };
  }
  function preserve(change) {
    const restore = capture();
    change();
    restore();
  }
  function align(target, viewportTop) {
    if (!target?.isConnected) return;
    interrupt();
    preferred = target.closest('#timeline-list > *, .conversation-form') || (pane.contains(target) ? target : null);
    pane.scrollTop += rectOf(target).top - viewportTop;
  }
  function reveal(target, block = 'center') {
    if (!target?.isConnected) return;
    interrupt();
    preferred = target.closest('#timeline-list > *, .conversation-form') || (pane.contains(target) ? target : null);
    // scrollIntoView can also move overflow:hidden ancestors and the fixed shell.
    const rect = rectOf(target), bounds = pane.getBoundingClientRect();
    const top = bounds.top + pane.clientTop + 12, bottom = top + pane.clientHeight - 24;
    if (block === 'start' || (block === 'center' && rect.bottom - rect.top > bottom - top))
      pane.scrollTop += rect.top - top;
    else if (block === 'center') pane.scrollTop += (rect.top + rect.bottom - top - bottom) / 2;
    else if (rect.top >= top && rect.bottom <= bottom || rect.top < top && rect.bottom > bottom) return;
    else pane.scrollTop += rect.top < top ? rect.top - top : rect.bottom - bottom;
  }
  return {capture, preserve, align, reveal, setTop, interrupt, get interaction() { return interaction; }};
}
