// Binds test doubles to Codex's own app-server protocol (test/fixtures/codex-app-server-schema.json,
// regenerated from the installed Codex by scripts/update-codex-schema.mjs).
import {appendFileSync, readFileSync} from 'node:fs';
import {compile} from './json-schema.mjs';

export const schema = JSON.parse(readFileSync(new URL('./fixtures/codex-app-server-schema.json', import.meta.url), 'utf8'));
const validate = compile(schema);

export const contractMethods = Object.keys(schema.methods);

const wire = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function violations(method, side, value) {
  const entry = schema.methods[method];
  if (!entry) return [`${method} is not in the protocol fixture (${schema.codex.version}), so chill-agent may be calling a method Codex does not have`];
  return validate(entry[side], wire(value) ?? null, side === 'params' ? '$params' : '$result');
}

export const requestViolations = (method, params) => violations(method, 'params', params);
export const responseViolations = (method, result) => violations(method, 'response', result);

// test/isolate-env.mjs points this at a file its exit hook reads, so a violation fails the test run even when chill-agent catches the error it caused.
export function recordViolation(text) {
  const log = process.env.CHILL_TEST_CONTRACT_LOG;
  if (log) appendFileSync(log, `${text}\n`);
}

export function contractError(method, side, list) {
  return `Codex contract violation in ${method} ${side} (${schema.codex.version}): ${list.join('; ')}`;
}

// Wraps an inline `{request}` Codex stub so it is held to the same protocol as test/fake-codex.mjs.
export function contractStub(handler) {
  return {
    async request(method, params) {
      const bad = requestViolations(method, params);
      if (bad.length) { const text = contractError(method, 'request', bad); recordViolation(text); throw new Error(text); }
      const result = wire(await handler(method, wire(params)));
      const wrong = responseViolations(method, result);
      if (wrong.length) { const text = contractError(method, 'response', wrong); recordViolation(text); throw new Error(text); }
      return result;
    },
  };
}

// A complete `Thread` as Codex returns it. Test doubles override only what a test is about.
export const codexThread = (overrides = {}) => {
  const id = overrides.id ?? 'thread';
  return {id, sessionId: id, cliVersion: '0.158.0-test', createdAt: 0, updatedAt: 0, cwd: '/tmp', preview: '', projectId: null, modelProvider: 'openai', source: 'appServer', ephemeral: false, status: {type: 'notLoaded'}, turns: [], ...overrides};
};

export const codexModel = (overrides = {}) => {
  const id = overrides.id ?? 'model';
  return {id, model: id, displayName: id, description: '', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{reasoningEffort: 'medium', description: 'Balanced'}], ...overrides};
};
