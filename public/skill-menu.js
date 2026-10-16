// Typing "/" in a comment suggests the project's skills, as agent harnesses do:
// at the start, after a space, or right after Japanese text, but not inside a
// path or URL. Choosing one inserts "/name " there and the text is sent as typed.
export function createSkillMenu({root, goalId, escapeHTML}) {
  const cache = new Map();
  let menu = null, items = [], active = 0, input = null;
  async function skills(id) {
    const saved = cache.get(id);
    if (saved && Date.now() - saved.at < 60000) return saved.list;
    const list = await fetch(`/api/goals/${id}/skills`).then(response => response.ok ? response.json() : []).catch(() => []);
    cache.set(id, {at: Date.now(), list});
    return list;
  }
  const query = field => {
    const before = field.value.slice(0, field.selectionStart);
    return field.selectionStart === field.selectionEnd ? /(?:^|[^A-Za-z0-9_./:~\\-])\/([^\s/]*)$/.exec(before)?.[1] ?? null : null;
  };
  function close() {
    menu?.remove(); menu = null; items = [];
    input?.setAttribute('aria-expanded', 'false'); input?.removeAttribute('aria-activedescendant');
  }
  function render() {
    if (!items.length) return close();
    if (!menu) {
      menu = document.createElement('ul');
      menu.className = 'skill-menu'; menu.id = 'skill-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Skills');
      menu.addEventListener('mousedown', event => event.preventDefault());
      menu.addEventListener('click', event => { const item = event.target.closest('[data-skill-index]'); if (item) choose(Number(item.dataset.skillIndex)); });
      input.closest('.comment-field').append(menu);
      input.setAttribute('aria-controls', 'skill-menu'); input.setAttribute('aria-expanded', 'true');
    }
    menu.innerHTML = items.map((skill, index) => `<li role="option" id="skill-option-${index}" data-skill-index="${index}" aria-selected="${index === active}" class="${index === active ? 'is-active' : ''}">
      <strong>/${escapeHTML(skill.name)}</strong><span>${escapeHTML(skill.description)}</span></li>`).join('');
    input.setAttribute('aria-activedescendant', `skill-option-${active}`);
    menu.querySelector('.is-active')?.scrollIntoView({block: 'nearest'});
  }
  function choose(index) {
    const skill = items[index];
    if (!skill || !input) return close();
    const before = input.value.slice(0, input.selectionStart), start = before.lastIndexOf('/');
    const rest = input.value.slice(input.selectionStart).replace(/^\S*/, '');
    input.value = `${before.slice(0, start)}/${skill.name} ${rest.replace(/^\s+/, '')}`;
    const caret = start + skill.name.length + 2;
    input.setSelectionRange(caret, caret);
    close();
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.focus();
  }
  root.addEventListener('input', async event => {
    const field = event.target;
    if (field.dataset?.input !== 'comment') return;
    const text = query(field);
    if (text === null) return close();
    input = field;
    const id = goalId(), list = await skills(id);
    if (id !== goalId() || query(field) !== text) return;
    const lower = text.toLowerCase();
    items = list.filter(skill => skill.name.toLowerCase().includes(lower))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)));
    active = 0;
    render();
  });
  root.addEventListener('keydown', event => {
    if (!menu || event.target !== input || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; render();
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation(); choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
  }, true);
  root.addEventListener('focusout', event => { if (event.target === input) close(); });
  return {close};
}
