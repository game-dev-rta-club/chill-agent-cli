// A hold preserves immutable Conversation events whose pending transport was
// withdrawn. The record belongs to the Goal and is the same for every agent;
// only an agent that can withdraw and resend its own transport creates one
// (lib/agents/codex-hold.mjs today). Anything that offers feedback must honor it.
import {join} from 'node:path';
import {readJson,writeJsonAtomically} from './storage.mjs';
import {workspaceDirectory} from './goal-store.mjs';

const path=id=>join(workspaceDirectory(),'feedback-holds',`${Number(id)}.json`);
export const readFeedbackHold=id=>readJson(path(id));
export const saveFeedbackHold=h=>writeJsonAtomically(path(h.goalId),h);
// Every phase except 'sent' still keeps the held events from the agent.
export const feedbackHeld=hold=>Boolean(hold&&hold.phase!=='sent');
