// Each adapter's owners (owner.mjs): a Claude conversation is its session and
// the context chill gave it; a Codex chat is its thread.
export const claudeConnection=goal=>goal?.owner?.agent==='claude-code'&&goal.owner.context?{harnessId:'claude-code',sessionId:goal.owner.id,contextId:goal.owner.context}:null;
export const codexThread=goal=>goal?.owner?.agent==='codex'?goal.owner.id:null;
export const claudeOwner=connection=>({agent:'claude-code',id:connection.sessionId,context:connection.contextId});
export const codexOwner=threadId=>({agent:'codex',id:threadId});
