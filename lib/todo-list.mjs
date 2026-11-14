// The agent's own todo list, in the one shape the Web shows whatever the agent:
// {items: [{text, status}], at}, status 'pending', 'active' or 'done', and `at`
// the time (ms) it last changed. The agent keeps the list with its own tools;
// a reader here turns one agent's tool calls into this shape, so another agent
// or tool needs only another reader. A call counts once its result is not an
// error, so a refused call changes nothing.
const statusOf = value => ({in_progress: 'active', inProgress: 'active', completed: 'done'})[value] || 'pending';
const textOf = value => typeof value === 'string' ? value.trim() : '';
const parsed = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };

// A list stays on the page while any item is open, or once the current work
// (since `since`, an ISO time) changed it; a list finished before is not shown.
export function shownTodo(list, since) {
  if (!list?.items.length) return null;
  return list.items.some(item => item.status !== 'done') || list.at >= Date.parse(since) ? list : null;
}

// Claude: Claude Desktop's update_plan, and Claude Code's TaskCreate and
// TaskUpdate (or the older TodoWrite). Feed it each tool_use part the agent
// wrote and each tool_result entry that answers one, in transcript order.
export function claudeTodoReader() {
  let items = [], at = 0;
  const calls = new Map();
  const replace = list => { items = list.map(item => ({text: textOf(item.content ?? item.text), status: statusOf(item.status)})).filter(item => item.text); };
  // Desktop's update_plan: the whole list, or a step by its 1-based number.
  function plan(input) {
    if (Array.isArray(input.items)) replace(input.items);
    for (const n of Array.isArray(input.done) ? input.done : []) if (items[n - 1]) items[n - 1].status = 'done';
    if (input.advance) {
      const now = items.findIndex(item => item.status === 'active');
      if (now >= 0) items[now].status = 'done';
      const next = items.findIndex((item, i) => i > now && item.status === 'pending');
      if (next >= 0) items[next].status = 'active';
    }
    if (items[input.start - 1]) items[input.start - 1].status = 'active';
  }
  function apply(call, result) {
    const input = call.input || {};
    if (call.name === 'TodoWrite') { const todos = parsed(input.todos); if (Array.isArray(todos)) replace(todos); }
    else if (call.name === 'TaskCreate') {
      const task = result?.task, id = task?.id ?? /^Task #(\S+) created/.exec(result?.text || '')?.[1];
      const text = textOf(task?.subject ?? input.subject);
      if (id != null && text) items.push({id: String(id), text, status: 'pending'});
    } else if (call.name === 'TaskUpdate') {
      const item = items.find(item => item.id === String(input.taskId));
      if (!item) return;
      if (input.status === 'deleted') items = items.filter(other => other !== item);
      else { if (input.status) item.status = statusOf(input.status); if (textOf(input.subject)) item.text = textOf(input.subject); }
    } else plan(input);
  }
  return {
    call(part) {
      if (part?.type !== 'tool_use' || !part.id) return;
      if (['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(part.name) || part.name?.endsWith('ccd_turn__update_plan')) calls.set(part.id, {name: part.name, input: part.input});
    },
    // A user entry: its tool_result parts, and Claude Code's own record of the result.
    result(entry, time) {
      for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        const call = part?.type === 'tool_result' && calls.get(part.tool_use_id);
        if (!call) continue;
        calls.delete(part.tool_use_id);
        if (part.is_error) continue;
        const text = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.map(piece => piece?.text || '').join('') : '';
        apply(call, {...(entry.toolUseResult && typeof entry.toolUseResult === 'object' ? entry.toolUseResult : {}), text});
        at = time || at;
      }
    },
    get list() { return items.length ? {items: items.map(({text, status}) => ({text, status})), at} : null; },
  };
}
