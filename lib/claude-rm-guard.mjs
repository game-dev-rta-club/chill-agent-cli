// Claude Code asks a person before rm/rmdir whose target is a glob or trailing
// slash directly under a shell variable ("$DIR"/*), even in bypass mode, because
// an empty variable would remove from the filesystem root. No allow rule or hook
// may approve it, so unattended work stops at the prompt. This PreToolUse check
// finds the same form first and asks Claude to rewrite it with a guarded
// expansion, which Claude Code accepts. It never approves anything itself.
const variable = String.raw`\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|[1-9@*])`;
// The variable may close a quote before the slash: "$DIR"/* or "$DIR/"*.
const flagged = new RegExp(String.raw`(?:^|[\s"'=])"?${variable}"?\/(?:"?\*|\s|"|'|$)`);
const removal = /(?:^|[;&|(`\n]|\$\(|\bthen\b|\bdo\b|\belse\b)\s*(?:sudo\s+|command\s+|builtin\s+|nohup\s+|time\s+)*(?:\/bin\/|\/usr\/bin\/)?(rm|rmdir)\b([^;&|`\n)]*)/g;

export function unguardedRemoval(command) {
  if (typeof command !== 'string') return null;
  for (const match of command.matchAll(removal)) {
    const args = match[2];
    const hit = args.match(flagged);
    if (hit) return `${match[1]}${args}`.trim().slice(0, 200);
  }
  return null;
}

export function claudeRmGuard(input) {
  if (input?.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return null;
  const found = unguardedRemoval(input.tool_input?.command);
  if (!found) return null;
  return {hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny',
    permissionDecisionReason:`chill-agent: Claude Code asks a person to approve rm/rmdir with a glob or trailing slash directly under a shell variable (${found}), even in bypass mode, which stops unattended work. Rewrite each such expansion as a guarded one, for example rm -f "\${DIR:?}"/*.png, or use a literal path (for $HOME use the literal path), then run the command again. Nothing ran.`}};
}
