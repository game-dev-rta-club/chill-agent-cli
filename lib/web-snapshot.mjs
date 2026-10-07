import {briefHTML} from './brief.mjs';
import {renderedEvent} from './markdown.mjs';

// Cache pure rendering only. Goal state and execution evidence are read afresh.
const rendered = new Map();
let bytes = 0;
function memo(key, render) {
  if (rendered.has(key)) return rendered.get(key);
  const value = render(), size = Buffer.byteLength(key) + Buffer.byteLength(value);
  if (size > 8 * 1024 * 1024) return value;
  while (rendered.size && (bytes + size > 8 * 1024 * 1024 || rendered.size >= 1024)) {
    const [oldKey, oldValue] = rendered.entries().next().value;
    bytes -= Buffer.byteLength(oldKey) + Buffer.byteLength(oldValue); rendered.delete(oldKey);
  }
  rendered.set(key, value); bytes += size; return value;
}
export function webBrief(brief) {
  const {version, format, createdAt} = brief;
  return {version, format, createdAt, html:format === 'html' ? '' : memo(`brief:${format}:${brief.body}`, () => briefHTML(brief.body, format))};
}
export function webSnapshot(goals) {
  return goals.map(({briefPath, briefs, conversation, ...goal}) => ({...goal,
    briefs:briefs.map((brief, index) => index === briefs.length - 1 ? webBrief(brief)
      : {version:brief.version, format:brief.format, createdAt:brief.createdAt}),
    conversation:conversation.map(event => ({...event,
      html:memo(`event:${event.text || ''}`, () => renderedEvent(event).html)})),
  }));
}
