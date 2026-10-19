import {readFileSync,writeFileSync} from 'node:fs';
import {beforeEach,afterEach,after} from 'node:test';

const declared = new WeakMap(), allowed = new WeakMap();
const starts = new WeakMap();

export function expectHidden(t, ...wheres) {
  declared.set(t, [...(declared.get(t) || []), ...wheres]);
}

// A failure the environment may cause, such as a read that needs a login the run never has.
export function allowHidden(t, ...wheres) {
  allowed.set(t, [...(allowed.get(t) || []), ...wheres]);
}

const matches = (expected, where) => expected instanceof RegExp ? expected.test(where) : expected === where;

export function installHiddenFailureCheck(file) {
  writeFileSync(file, '');
  process.env.CHILL_AGENT_HIDDEN_FAILURES = file;
  let checked = 0;
  const readSince = from => {
    const bytes = readFileSync(file);
    checked = bytes.length;
    return bytes.subarray(from).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const verify = (lines, expected, optional = []) => {
    const problems = [
      ...lines.filter(({where}) => ![...expected, ...optional].some(e => matches(e, where))).map(({where, message}) => `undeclared hidden failure ${where}: ${message}`),
      ...expected.filter(e => !lines.some(({where}) => matches(e, where))).map(e => `expectHidden(${e}) never happened`),
    ];
    if (problems.length) throw new Error(`${problems.join('\n')}\nDeclare an injected failure with expectHidden(t, 'where').`);
  };
  beforeEach(t => { starts.set(t, checked); });
  afterEach(t => verify(readSince(starts.get(t) ?? checked), declared.get(t) || [], allowed.get(t) || []));
  after(() => verify(readSince(checked), []));
}
