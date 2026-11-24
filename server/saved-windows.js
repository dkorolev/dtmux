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
//     "sessions": { "<session>": [ { id, name, autoName, dir, branch?, agent?, remote? }, ... ] },
//     "tabOrders": { "<session>": [ "<window id>", ... ] } }
// `branch`: the git branch `dir` was on. `agent`: { name, command }, the coding
// agent that ran there and the command that resumes it (see agent-close.js).
// `remote`: { name, host, address?, upSince? }, for a tab on a remote VM (see remotes.js).
// `panes`, `layout`, `activePane`: a window of more than one pane, pane by
// pane (see window-panes.js); `dir` and `agent` are then its active pane's.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './paths.js';
import { watchTarget } from './tmux-watch.js';

export const SAVED_FILE = path.join(STATE_DIR, 'saved-windows.json');
export const ID_OPTION = '@dtmux_id';
export const newWindowId = () => randomUUID();

// Emits 'change' (session) when a session's saved list changes.
export const savedEvents = new EventEmitter();
savedEvents.setMaxListeners(0);

const isEntry = (e) =>
  e && typeof e.id === 'string' && e.id && typeof e.name === 'string' && typeof e.dir === 'string';

// The fields kept for a saved window; anything else is dropped.
const cleanAgent = (agent) =>
  agent && typeof agent.name === 'string' && typeof agent.command === 'string' && agent.command ? { name: agent.name, command: agent.command } : null;

function clean({ id, name, autoName, dir, branch, agent, remote, watch, panes, layout, activePane }) {
  const e = { id, name, autoName: Boolean(autoName), dir };
  if (remote && typeof remote.name === 'string' && typeof remote.host === 'string' && remote.name && remote.host) {
    e.remote = { name: remote.name, host: remote.host };
    if (typeof remote.address === 'string' && remote.address) e.remote.address = remote.address;
    if (Number.isInteger(remote.upSince)) e.remote.upSince = remote.upSince;
  }
  const target = watchTarget(watch?.host, watch?.session);
  if (target) e.watch = target;
  if (typeof branch === 'string' && branch) e.branch = branch;
  if (cleanAgent(agent)) e.agent = cleanAgent(agent);
  if (!e.remote && Array.isArray(panes) && panes.length > 1 && panes.length <= 64 && typeof layout === 'string' && /^[0-9a-f]{4},[0-9x,{}[\]]+$/.test(layout)) {
    const kept = panes.filter((p) => p && typeof p.dir === 'string');
    if (kept.length === panes.length) {
      e.panes = kept.map((p) => {
        const out = { dir: p.dir };
        if (typeof p.branch === 'string' && p.branch) out.branch = p.branch;
        if (cleanAgent(p.agent)) out.agent = cleanAgent(p.agent);
        return out;
      });
      e.layout = layout;
      e.activePane = Number.isInteger(activePane) && activePane >= 0 && activePane < panes.length ? activePane : 0;
    }
  }
  return e;
}

const validOrder = (order) =>
  Array.isArray(order) && order.length <= 10_000 && order.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128);
const tabOrders = new Map();

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
    const out = new Map();
    for (const [session, list] of Object.entries(data?.sessions ?? {})) {
      const good = Array.isArray(list) ? list.filter(isEntry) : [];
      if (good.length) out.set(session, good.map(clean));
    }
    for (const [session, order] of Object.entries(data?.tabOrders ?? {})) {
      if (validOrder(order)) tabOrders.set(session, [...new Set(order)]);
    }
    return out;
  } catch {
    return new Map();
  }
}

let saved = load();

function persist(orders = tabOrders) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const body = { version: 1, savedAt: new Date().toISOString(), sessions: Object.fromEntries(saved), tabOrders: Object.fromEntries(orders) };
  const tmp = `${SAVED_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, SAVED_FILE);
}

// The toolbar order includes both live and saved window IDs.
export const tabOrderFor = (session) => tabOrders.get(session) ?? null;

export function saveTabOrder(session, order) {
  if (!validOrder(order)) return;
  const next = [...new Set(order)];
  const previous = tabOrders.get(session);
  if (previous?.length === next.length && next.every((id, i) => id === previous[i])) return;
  persist(new Map(tabOrders).set(session, next));
  tabOrders.set(session, next);
}

// Every saved window of every session.
export const allSaved = () => [...saved.values()].flat().map((e) => ({ ...e }));

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

// Save one live window for later, as a page's Disconnect does: it becomes a
// dotted tab, the same as if dtmux had stopped. Replaces an entry with its id.
// Rename a dotted tab; false when there is no such one.
export function renameSaved(session, id, name) {
  const entry = (saved.get(session) ?? []).find((e) => e.id === id);
  if (!entry) return false;
  entry.name = name;
  entry.autoName = false;
  persist();
  savedEvents.emit('change', session);
  return true;
}

export function addSaved(session, entry) {
  const list = (saved.get(session) ?? []).filter((e) => e.id !== entry.id);
  list.push(clean(entry));
  saved.set(session, list);
  persist();
  savedEvents.emit('change', session);
}

// Record the live windows at shutdown: per session, live windows in tab order
// first, then the saved ones that were never reopened. `live` items are
// { session, index, id, name, autoName, dir, branch?, agent? }.
//
// A live window that was not reopened from the list but looks the same as a
// saved one (same name, directory and naming) stands in for it, one for one.
// Without that, the window tmux must create to start a session after a
// restart (a shell in ~) would add another copy to the list on every stop.
const sameLook = (a, b) =>
  !a.watch && !b.watch && a.name === b.name && a.dir === b.dir && a.autoName === b.autoName && a.remote?.host === b.remote?.host;
export function saveOnStop(live) {
  const next = new Map();
  for (const w of [...live].sort((a, b) => a.index - b.index)) {
    if (!next.has(w.session)) next.set(w.session, []);
    next.get(w.session).push(clean({ ...w, id: w.id || newWindowId() }));
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
