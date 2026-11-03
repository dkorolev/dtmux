// Windows saved when dtmux stops, offered back after it starts again.
//
// When the daemon stops gently it records every tmux window of every session:
// its long unique id (the window option @dtmux_id), name and directory, in tab
// order. Nothing is reopened on start. The page shows the saved windows as
// dotted tabs, and clicking one reopens it: a new window with that name, in
// that directory. Windows not reopened yet stay saved across further restarts.
//
// ~/.dtmux/saved-windows.json:
//   { "version": 1, "savedAt": ISO time,
//     "sessions": { "<session>": [ { id, name, autoName, dir }, ... ] } }
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './paths.js';

export const SAVED_FILE = path.join(STATE_DIR, 'saved-windows.json');
export const ID_OPTION = '@dtmux_id';
export const newWindowId = () => randomUUID();

// Emits 'change' (session) when a session's saved list changes.
export const savedEvents = new EventEmitter();
savedEvents.setMaxListeners(0);

const isEntry = (e) =>
  e && typeof e.id === 'string' && e.id && typeof e.name === 'string' && typeof e.dir === 'string';

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
    const out = new Map();
    for (const [session, list] of Object.entries(data?.sessions ?? {})) {
      const good = Array.isArray(list) ? list.filter(isEntry) : [];
      if (good.length) out.set(session, good.map(({ id, name, autoName, dir }) => ({ id, name, autoName: Boolean(autoName), dir })));
    }
    return out;
  } catch {
    return new Map();
  }
}

let saved = load();

function persist() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const body = { version: 1, savedAt: new Date().toISOString(), sessions: Object.fromEntries(saved) };
  const tmp = `${SAVED_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, SAVED_FILE);
}

export function savedFor(session) {
  return (saved.get(session) ?? []).map((e) => ({ ...e }));
}

// Remove one saved window, for reopening it. Returns it, or null if it is
// already gone (another tab got there first).
export function takeSaved(session, id) {
  const list = saved.get(session) ?? [];
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [entry] = list.splice(i, 1);
  if (!list.length) saved.delete(session);
  persist();
  savedEvents.emit('change', session);
  return entry;
}

// Record the live windows at shutdown: per session, live windows in tab order
// first, then the saved ones that were never reopened. `live` items are
// { session, index, id, name, autoName, dir }.
//
// A live window that was not reopened from the list but looks the same as a
// saved one (same name, directory and naming) stands in for it, one for one.
// Without that, the window tmux must create to start a session after a
// restart (a shell in ~) would add another copy to the list on every stop.
const sameLook = (a, b) => a.name === b.name && a.dir === b.dir && a.autoName === b.autoName;
export function saveOnStop(live) {
  const next = new Map();
  for (const w of [...live].sort((a, b) => a.index - b.index)) {
    if (!next.has(w.session)) next.set(w.session, []);
    next.get(w.session).push({ id: w.id || newWindowId(), name: w.name, autoName: w.autoName, dir: w.dir });
  }
  for (const [session, list] of saved) {
    const liveHere = next.get(session) ?? [];
    const savedIds = new Set(list.map((e) => e.id));
    const standIns = liveHere.filter((e) => !savedIds.has(e.id)); // not reopened from the list
    const have = new Set(liveHere.map((e) => e.id));
    const rest = list.filter((e) => {
      if (have.has(e.id)) return false; // reopened: saved again as a live window
      const i = standIns.findIndex((w) => sameLook(w, e));
      if (i < 0) return true;
      standIns.splice(i, 1);
      return false;
    });
    if (rest.length) next.set(session, [...liveHere, ...rest]);
  }
  saved = next;
  persist();
  return [...saved.values()].reduce((n, l) => n + l.length, 0);
}
