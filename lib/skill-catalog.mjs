// Skills in the project and the user's home, for the Web's "/" suggestions.
// Every harness's folders are listed: an agent can read any SKILL.md, even one
// its harness does not load by name.
import {readdir,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readGoalContext} from './goal-store.mjs';
import {projectProfile} from './project-workspace.mjs';

const folders = [['.claude','skills'],['.claude','commands'],['.agents','skills'],['.codex','skills']];
// Simple frontmatter: name and description, including folded (>-) values.
export function skillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {}, lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[>|]-?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    fields[field[1]] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}
async function entries(directory) {
  try { return await readdir(directory, {withFileTypes:true}); }
  catch (error) { if (['ENOENT','ENOTDIR'].includes(error.code)) return []; throw error; }
}
// Skill folders may be grouped in subfolders (Codex keeps its own under .system).
async function readFolder(directory, scope, depth = 0) {
  const found = [];
  for (const entry of await entries(directory)) {
    try {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let text;
        const file = join(directory, entry.name, 'SKILL.md');
        try { text = await readFile(file, 'utf8'); }
        catch (error) {
          if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
          if (depth < 3) found.push(...await readFolder(join(directory, entry.name), scope, depth + 1));
          continue;
        }
        const meta = skillFrontmatter(text);
        found.push({name:meta.name || entry.name, description:meta.description || '', scope, file});
      } else if (depth === 0 && entry.name.endsWith('.md')) {
        const file = join(directory, entry.name), meta = skillFrontmatter(await readFile(file, 'utf8'));
        found.push({name:entry.name.slice(0, -3), description:meta.description || '', scope, file});
      }
    } catch (error) { if (!['ENOENT','ENOTDIR','EISDIR'].includes(error.code)) throw error; }
  }
  return found;
}
// The Web lists names and descriptions; file paths stay on this machine.
export async function listSkills(options = {}) {
  return (await findSkills(options)).map(({file, ...skill}) => skill);
}
async function findSkills({project, home = homedir()} = {}) {
  const skills = new Map();
  // Project skills come first; a user skill with the same name is hidden by it.
  for (const [base, scope] of [[project, 'project'], [home, 'user']]) {
    if (!base) continue;
    for (const parts of folders) for (const skill of await readFolder(join(base, ...parts), scope)) if (!skills.has(skill.name)) skills.set(skill.name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// "/name" anywhere in a sentence, also right after Japanese text ("これを/grillingで"),
// but not inside a path or URL ("a/b", "https://x/y").
const SKILL_MENTION = /(?:^|[^A-Za-z0-9_./:~\\-])\/([A-Za-z0-9][\w.:-]*)/g;
// Skills named as "/name" in feedback, with the file to read. A harness may
// not load a user skill by name, but the agent can always read its SKILL.md.
export async function mentionedSkills(texts, {project = projectProfile()?.path, home} = {}) {
  const names = new Set(texts.flatMap(text => [...String(text || '').matchAll(SKILL_MENTION)].map(m => m[1].replace(/[.:-]+$/, ''))));
  if (!names.size) return [];
  return (await findSkills({project, home})).filter(skill => names.has(skill.name));
}
export const skillLines = skills => skills.length ? `Skills named in the feedback (invoke by name if your harness lists it; otherwise read the file and follow it):\n${skills.map(s => `/${s.name} (${s.scope}): ${s.file}`).join('\n')}` : '';
export async function goalSkills(goalId) {
  await readGoalContext(goalId);
  return listSkills({project:projectProfile()?.path});
}
