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
        try { text = await readFile(join(directory, entry.name, 'SKILL.md'), 'utf8'); }
        catch (error) {
          if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
          if (depth < 3) found.push(...await readFolder(join(directory, entry.name), scope, depth + 1));
          continue;
        }
        const meta = skillFrontmatter(text);
        found.push({name:meta.name || entry.name, description:meta.description || '', scope});
      } else if (depth === 0 && entry.name.endsWith('.md')) {
        const meta = skillFrontmatter(await readFile(join(directory, entry.name), 'utf8'));
        found.push({name:entry.name.slice(0, -3), description:meta.description || '', scope});
      }
    } catch (error) { if (!['ENOENT','ENOTDIR','EISDIR'].includes(error.code)) throw error; }
  }
  return found;
}
export async function listSkills({project, home = homedir()} = {}) {
  const skills = new Map();
  // Project skills come first; a user skill with the same name is hidden by it.
  for (const [base, scope] of [[project, 'project'], [home, 'user']]) {
    if (!base) continue;
    for (const parts of folders) for (const skill of await readFolder(join(base, ...parts), scope)) if (!skills.has(skill.name)) skills.set(skill.name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function goalSkills(goalId) {
  await readGoalContext(goalId);
  return listSkills({project:projectProfile()?.path});
}
