// ~/.dtmux.yaml: load and validate against a strict schema.
//
// A missing or empty file means "all defaults". Anything present must match
// the schema exactly: unknown keys, wrong types, duplicate keys and YAML
// syntax errors are all rejected, with every problem listed at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';

export const CONFIG_PATH = process.env.DTMUX_CONFIG || path.join(os.homedir(), '.dtmux.yaml');

import { checkRemotes, normalizeRemotes } from './remote-config.js';

// key -> { describe, default, check(value) -> error string(s) | null,
//          normalize?(value) -> the value the rest of dtmux sees }
export const SCHEMA = {
  port: {
    describe: 'integer from 1 to 65535',
    default: 7778,
    check: (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? null : 'must be an integer from 1 to 65535'),
  },
  remotes: {
    describe: 'mapping: remote name -> how to reach it (see README, "Remote sessions")',
    default: {},
    check: checkRemotes,
    normalize: normalizeRemotes,
  },
};

export class ConfigError extends Error {
  constructor(file, problems) {
    super(`${file} is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// Validate a YAML string. Returns the full config with defaults filled in, or
// throws ConfigError.
export function parseConfig(text, file = CONFIG_PATH) {
  const defaults = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length) throw new ConfigError(file, doc.errors.map((e) => e.message.split('\n')[0]));
  const data = doc.toJS();
  if (data === null || data === undefined) return defaults;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(file, ['top level must be a mapping (key: value), e.g. "port: 7778"']);
  }
  const problems = [];
  for (const [key, value] of Object.entries(data)) {
    const spec = SCHEMA[key];
    if (!spec) {
      problems.push(`unknown key "${key}" (allowed: ${Object.keys(SCHEMA).join(', ')})`);
      continue;
    }
    const err = spec.check(value);
    if (Array.isArray(err)) problems.push(...err.map((e) => `${key}.${e}`));
    else if (err) problems.push(`${key}: ${err}, got ${show(value)}`);
  }
  if (problems.length) throw new ConfigError(file, problems);
  const out = { ...defaults, ...data };
  for (const [key, spec] of Object.entries(SCHEMA)) if (spec.normalize) out[key] = spec.normalize(out[key]);
  return out;
}

export function loadConfig(file = CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') text = '';
    else throw new ConfigError(file, [err.message]);
  }
  return parseConfig(text, file);
}
