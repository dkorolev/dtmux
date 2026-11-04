// The Settings page's connectors: the `remotes:` of ~/.dtmux.yaml, read as
// written and saved back in place, comments and the rest of the file kept.
// A save is checked as a whole (config.js) before it is written; a file
// that is invalid is never written.
import fs from 'node:fs';
import { parseDocument } from 'yaml';
import { CONFIG_PATH, parseConfig } from './config.js';
import { fieldSpecs } from './remote-config.js';

const readText = () => {
  try {
    return fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
};

// { path, remotes: { name: { field: value } } as written, specs, problems }.
export function readConnectors() {
  const text = readText();
  let problems = null;
  try {
    parseConfig(text);
  } catch (e) {
    problems = e.problems ?? [e.message];
  }
  const doc = parseDocument(text);
  const remotes = doc.toJS()?.remotes ?? {};
  return { path: CONFIG_PATH, remotes, specs: fieldSpecs(), problems };
}

// Write `remotes` (name -> { field: value }; a field set to null or '' goes
// away, so its default applies) -> { ok, problems }.
export function saveConnectors(remotes) {
  if (!remotes || typeof remotes !== 'object' || Array.isArray(remotes)) return { ok: false, problems: ['nothing to save'] };
  const text = readText();
  const doc = parseDocument(text);
  if (!doc.contents) doc.contents = doc.createNode({});
  const had = doc.toJS()?.remotes ?? {};
  for (const name of Object.keys(had)) if (!(name in remotes)) doc.deleteIn(['remotes', name]);
  for (const [name, fields] of Object.entries(remotes)) {
    if (!fields || typeof fields !== 'object') continue;
    const before = had[name] ?? {};
    for (const field of Object.keys(before)) if (!(field in fields)) doc.deleteIn(['remotes', name, field]);
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === '') doc.deleteIn(['remotes', name, field]);
      else if (JSON.stringify(before[field]) !== JSON.stringify(value)) doc.setIn(['remotes', name, field], value);
    }
  }
  const out = doc.toString({ flowCollectionPadding: false });
  try {
    parseConfig(out);
  } catch (e) {
    return { ok: false, problems: e.problems ?? [e.message] };
  }
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, CONFIG_PATH);
  return { ok: true, problems: null };
}
