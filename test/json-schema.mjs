// A small JSON Schema (draft-07) validator for the Codex protocol fixture.
// It covers the keywords Codex's generated schemas use and throws on any other, so a schema change can never be skipped silently.
// Objects are strict: a property the schema does not declare is a violation, because Codex serializes every field it has.
const annotations = new Set(['$schema', '$comment', 'title', 'description', 'default', 'definitions']);
const validating = new Set(['$ref', 'type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'allOf', 'anyOf', 'oneOf', 'minimum', 'minLength', 'format']);
const integerFormats = new Set(['int32', 'int64', 'uint', 'uint16', 'uint32', 'uint64']);
const combinators = ['allOf', 'anyOf', 'oneOf'];

function check(node, path) {
  if (Array.isArray(node)) { node.forEach((child, index) => check(child, `${path}[${index}]`)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === 'definitions') { for (const [name, child] of Object.entries(value)) check(child, `${path}/${key}/${name}`); continue; }
    if (key === 'default' || key === 'enum') continue;
    if (!validating.has(key) && !annotations.has(key)) throw new Error(`Unsupported JSON Schema keyword "${key}" at ${path}. Teach test/json-schema.mjs about it before trusting the contract.`);
    if (key === 'format' && !integerFormats.has(value)) throw new Error(`Unsupported JSON Schema format "${value}" at ${path}.`);
    if (key === 'items' && (Array.isArray(value) || !['object', 'boolean'].includes(typeof value))) throw new Error(`Unsupported tuple "items" at ${path}.`);
    if (key === 'additionalProperties' && typeof value !== 'boolean' && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`Unsupported "additionalProperties" at ${path}.`);
    if (key === 'type') for (const type of [value].flat()) if (!['string', 'integer', 'number', 'boolean', 'null', 'object', 'array'].includes(type)) throw new Error(`Unsupported type "${type}" at ${path}.`);
    if (key !== 'definitions') check(value, `${path}/${key}`);
  }
}

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const isType = (value, type) => type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeOf(value) === type;

// Codex groups its v2 protocol under `definitions.v2`; any other unknown shape must fail rather than pass as a namespace.
const namespaces = new Set(['v2']);

function checkDefinitions(definitions, path) {
  for (const [name, node] of Object.entries(definitions)) {
    if (namespaces.has(name)) checkDefinitions(node, `${path}/${name}`);
    else check(node, `${path}/${name}`);
  }
}

// `root.definitions` holds named schemas, optionally grouped in namespaces such as `v2`.
export function compile(root) {
  checkDefinitions(root.definitions, '#/definitions');
  const resolve = ref => {
    const target = ref.slice('#/definitions/'.length).split('/').reduce((node, key) => node?.[key], root.definitions);
    if (!ref.startsWith('#/definitions/') || target === undefined) throw new Error(`Unresolvable schema reference ${ref}`);
    return target;
  };
  const describe = value => JSON.stringify(value)?.slice(0, 60);

  function validate(schema, value, path, outer) {
    if (typeof schema === 'boolean') return schema ? [] : [`${path}: no value is allowed here`];
    if (schema.$ref) return validate(resolve(schema.$ref), value, path, outer);
    const violations = [];
    if (schema.type !== undefined && ![schema.type].flat().some(type => isType(value, type))) return [`${path}: expected ${[schema.type].flat().join(' or ')}, got ${describe(value)}`];
    if (schema.enum && !schema.enum.some(option => option === value)) violations.push(`${path}: ${describe(value)} is not one of ${describe(schema.enum)}`);
    if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) violations.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) violations.push(`${path}: string is shorter than ${schema.minLength}`);
    if (Array.isArray(value) && schema.items) value.forEach((item, index) => violations.push(...validate(schema.items, item, `${path}[${index}]`, new Set())));
    const known = new Set([...outer, ...Object.keys(schema.properties ?? {})]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of schema.required ?? []) if (!(name in value)) violations.push(`${path}: missing required property "${name}"`);
      for (const [name, child] of Object.entries(schema.properties ?? {})) if (name in value) violations.push(...validate(child, value[name], `${path}.${name}`, new Set()));
      const extra = Object.keys(value).filter(name => !known.has(name));
      const hasCombinator = combinators.some(key => schema[key]);
      if (schema.additionalProperties === undefined || schema.additionalProperties === false) {
        if (!hasCombinator && (schema.properties || outer.size || schema.additionalProperties === false)) for (const name of extra) violations.push(`${path}.${name}: property is not in the schema`);
      } else if (typeof schema.additionalProperties === 'object') for (const name of extra) violations.push(...validate(schema.additionalProperties, value[name], `${path}.${name}`, new Set()));
    }
    for (const branch of schema.allOf ?? []) violations.push(...validate(branch, value, path, known));
    for (const key of ['anyOf', 'oneOf']) {
      if (!schema[key]) continue;
      const results = schema[key].map(branch => validate(branch, value, path, known));
      const matching = results.filter(result => !result.length).length;
      if (!matching || (key === 'oneOf' && matching > 1)) {
        const closest = results.reduce((best, result) => result.length < best.length ? result : best);
        violations.push(matching ? `${path}: matches ${matching} of the ${key} variants, expected exactly one` : `${path}: matches none of the ${key} variants; closest: ${closest.join('; ')}`);
      }
    }
    return violations;
  }
  return (schema, value, path = '$') => validate(schema, value, path, new Set());
}
