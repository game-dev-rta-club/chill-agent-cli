// Each adapter's owners (owner.mjs): a Claude conversation is its session and
// the context chill gave it; a Codex chat is its thread.
export const claudeConnectionOf=owner=>owner?.agent==='claude-code'&&owner.context?{harnessId:'claude-code',sessionId:owner.id,contextId:owner.context}:null;
export const codexThreadOf=owner=>owner?.agent==='codex'?owner.id:null;
export const claudeConnection=goal=>claudeConnectionOf(goal?.owner);
export const codexThread=goal=>codexThreadOf(goal?.owner);
export const claudeOwner=connection=>({agent:'claude-code',id:connection.sessionId,context:connection.contextId});
export const codexOwner=threadId=>({agent:'codex',id:threadId});
