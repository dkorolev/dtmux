// Bridges one browser connection to a tmux session in control mode.
//
// Each tmux pane becomes its own xterm.js terminal in the browser, so the
// browser holds the real scrollback and scrolling never round-trips to tmux.
// Messages to the browser, all JSON:
//   hello  { session, prefix, commit, build, remotes }  once attached; `build`
//                                         fingerprints the page's files, see app.js;
//                                         `remotes`: [{ name, label, color, plan, ttlSeconds }]
//   state  { windows, panes }             after any structural change; each
//                                         window carries its long id as `uid`, and
//                                         `remote` { name, host, address, upSince, ended } when on
//                                         a remote machine (ended: its session ended, the tab waits)
//   init   { p, d }                       a pane's history and modes, base64
//   out    { p, d }                       pane output, base64
//   paste-path { p, path } | { p, error } where a pasted image was saved
//   exit   { reason, sessionGone }        tmux detached or the session ended
//   prompt { id, kind, prompts, inputs, single, numeric, confirmKey, enterConfirms }
//                                         a binding wants an answer (see tmux-bindings.js)
//   notice { text, kind?, p? }            tmux messages, command output, things we undid;
//                                         with `p`, about that pane's tab (shown on it)
//   journal { p, agent, command, dir, branch, commit, dirty }
//                                         a resume command showed up on a pane
//   saved  { windows: [{ id, name, dir, branch, agent, remote }], order? }
//                                         windows saved when dtmux last stopped
//   taken  {}                             a newer page took this session; this
//                                         socket closes (code 4001) right after
//   idle   { session, build, remotes }    the session does not exist but saved
//                                         windows do: nothing is started until
//                                         the page sends resume or new-session
// Messages from the browser:
//   in     { p, d, bin? }   bytes for a pane (xterm.js onData / onBinary)
//   paste-image { p, data }  a screenshot, base64; answered with paste-path
//   size   { cols, rows }   the browser's grid size for the whole session
//   keys   { keys }         tmux key names routed through tmux key bindings
//   answer { id, values }   the reply to a prompt; values null when cancelled
//   select-window { w }, select-pane { p }, new-window, open { url }
//   new-watch { target }  watch an existing tmux session over SSH
//   new-remote { name }    a new tab on a new VM of that remote (see remotes.js)
//   resize-pane { p, axis, size }  drag a border; axis "x" (width) or "y" (height)
//   resume { id }          reopen a saved window: same name, same directory
//   tab-order { order }    persist the toolbar order (live and saved window IDs)
//   reorder { ws }         put tmux's windows in this order (window ids, a tab drag)
//   info { w }             what the tab's tooltip shows, answered with
//                          info { w, panes: [{ id, active, dir, openSecs, running }], upSince }
//                          (upSince: unix seconds a remote tab's VM has been up)
//   disconnect { w }       save a window for later and close it: it turns dotted
//   close { w }            close a window for good, no dotted tab (works on a stuck one);
//                          a remote tab's machine is deleted with it
//   forget { id }          drop a saved window for good; a remote one's machine too
//   delete-remote { w } | { id }  the same as close / forget (older pages)
//   new-session            while idle: start the session empty
//   stop                   stop the whole daemon
//   restart                stop the daemon and start it again: windows saved, tmux ended
//   soft-restart           start the daemon again, leaving tmux and its shells running
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { TmuxControl, TMUX_BIN, quote, tmuxArgs } from './tmux-control.js';
import { trackKitty, recordKittyCommand, kittyRestoreSequence, forgetPane } from './kitty-tracker.js';
import { openExternal } from './open-external.js';
import { parseBinding, fillTemplate } from './tmux-bindings.js';
import { findResumeHint } from './resume-hint.js';
import { windowInfo } from './pane-info.js';
import { closeAgents } from './agent-close.js';
import { branchOf, restoreBranch } from './git-branch.js';
import { savedFor, allSaved, takeSaved, addSaved, renameSaved, savedEvents, newWindowId, ID_OPTION, tabOrderFor, saveTabOrder } from './saved-windows.js';
import { issueDeleteCode, takeDeleteCode } from './delete-codes.js';
import { REMOTE_OPTION, REMOTE_UP_OPTION, REMOTE_FORMAT, REMOTE_SUBSCRIPTION, parseRemote, remoteValue, currentRemotes, newHost, remoteCommand } from './remotes.js';
import { pageRemotes } from './remote-config.js';
import { WATCH_FORMAT, WATCH_OPTION, parseWatch, parseWatchInput, watchCommand, watchInputProblem, watchTarget, watchValue } from './tmux-watch.js';
import { SPLIT_HOOK, remoteAction, actionKeys } from './remote-keys.js';
import { listPanes, agentsByPane, panesOf, windowAgent } from './window-panes.js';
import { events as containerEvents, containerStatus, ensureImage } from './gh-check.js';
import { hostStatus, cleanCheck, machineStatus, instrument, uninstrument } from './gh-remote.js';
import { readConnectors, saveConnectors } from './settings.js';
import { kindOf, deleteMachine } from './remote-kinds.js';
import { savePastedImage, uploadPaste, pasteDir } from './paste-image.js';
import { dropMachine } from './machine-ledger.js';

const HISTORY_LINES = 10000; // keep in sync with the browser's scrollback
const SEND_CHUNK = 256; // bytes per send-keys command

const WINDOW_FORMAT = [
  '#{window_id}',
  '#{window_index}',
  '#{window_active}',
  '#{window_visible_layout}',
  `#{${ID_OPTION}}`,
  REMOTE_FORMAT,
  WATCH_FORMAT,
  '#{window_name}',
].join('\t');
const PANE_FORMAT = [
  '#{pane_id}',
  '#{window_id}',
  '#{pane_active}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_current_command}',
].join('\t');
const MODE_FORMAT = [
  '#{alternate_on}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{keypad_cursor_flag}',
  '#{mouse_standard_flag}',
  '#{mouse_button_flag}',
  '#{mouse_any_flag}',
  '#{mouse_sgr_flag}',
  '#{bracket_paste_flag}',
  '#{pane_current_command}',
].join('\t');

// Notifications after which the window / pane picture may have changed.
const STRUCTURAL = new Set([
  'layout-change',
  'window-add',
  'window-close',
  'unlinked-window-close',
  'window-renamed',
  'session-window-changed',
  'window-pane-changed',
  'session-changed',
  'pane-mode-changed',
]);

// Pane modes draw only on tmux's own screen, which control mode never shows.
// A pane left in one swallows typing invisibly, so they are cancelled.
const MODE_NOTICES = {
  'copy-mode': 'tmux copy mode is not shown here: scroll with the wheel and select with the mouse.',
  'view-mode': 'tmux view mode is not shown here.',
  'tree-mode': 'tmux choose-tree is not shown here: use the tabs to switch windows.',
  'clock-mode': 'tmux clock mode is not shown here.',
};
// Keys sent from outside to close an overlay that has wedged the control
// client (a menu, the pane picker, a prompt from a nested binding).
const UNWEDGE_KEYS = ['Escape', 'C-c', 'Escape', 'C-c'];

// What a page sees of a saved window.
const pageEntry = ({ id, name, dir, branch, agent, remote, watch }) => ({
  id,
  name,
  dir,
  branch: branch ?? null,
  agent: agent ?? null,
  remote: remote ?? null,
  watch: watch ?? null,
});

// Delete a remote tab's machine for good, the page having asked (`why`, for
// the log); `send` reports how it went.
function deleteTabMachine(where, why, send) {
  let remote;
  try {
    remote = currentRemotes()[where.name];
  } catch (err) {
    return send({ t: 'notice', text: err.message, kind: 'bad' });
  }
  if (!remote) return send({ t: 'notice', text: `No remote "${where.name}" in ~/.dtmux.yaml: ${where.host} was not deleted.`, kind: 'bad' });
  const kind = kindOf(remote);
  send({ t: 'notice', text: `Deleting ${remote.label} ${kind.noun} ${where.host}…` });
  deleteMachine(remote, where.host, `page: ${why}`).then(
    () => {
      try {
        dropMachine(where.name, where.host);
      } catch {} // the sweep drops it once it sees the machine gone
      send({ t: 'notice', text: `Deleted ${remote.label} ${kind.noun} ${where.host}.` });
    },
    (err) => send({ t: 'notice', text: `Could not delete ${where.host}: ${err.message}`, kind: 'bad' }),
  );
}

// Deleting a remote tab's machine takes the four digits the daemon issued for
// that tab (see delete-codes.js); the page shows them and the user types them.
// `key` names the tab: `w:<window id>` or `saved:<dotted tab id>`.
const deleteKey = (msg) => (isWindowId(msg.w) ? `w:${msg.w}` : typeof msg.id === 'string' ? `saved:${msg.id}` : null);

// The remote a delete request names, or null: a live window's, or a dotted tab's.
function remoteOfTarget(msg, cb) {
  if (isWindowId(msg.w)) {
    execFile(TMUX_BIN, tmuxArgs('display', '-p', '-t', msg.w, REMOTE_FORMAT), (err, out) => {
      if (err) return cb(null);
      cb(parseRemote(out.trim()) ?? null);
    });
  } else {
    cb(allSaved().find((e) => e.id === msg.id)?.remote ?? null);
  }
}

// The page asked for a delete's code: issued for a remote tab only.
function answerDeleteCode(msg, send) {
  const key = deleteKey(msg);
  if (!key) return;
  remoteOfTarget(msg, (where) => {
    if (!where) return send({ t: 'delete-code', key, code: null });
    send({ t: 'delete-code', key, code: issueDeleteCode(key) });
  });
}

// True when a delete for `key` may go ahead; otherwise says why not.
function deleteConfirmed(key, code, send) {
  if (takeDeleteCode(key, code)) return true;
  send({ t: 'notice', text: 'Not deleted: the four digits were wrong or came too late. Ask again for a new code.', kind: 'bad' });
  return false;
}

// Drop a saved (dotted) tab for good; a remote one's machine goes with it,
// once its code is confirmed.
function forgetSaved(session, id, code, send) {
  const known = allSaved().find((e) => e.id === id);
  if (known?.remote && !deleteConfirmed(`saved:${id}`, code, send)) return;
  const entry = takeSaved(session, id);
  if (entry?.remote) deleteTabMachine(entry.remote, 'Delete on its dotted tab (code confirmed)', send);
}

// The remotes for the page; none while ~/.dtmux.yaml is invalid.
function remotesForPage() {
  try {
    return pageRemotes(currentRemotes());
  } catch {
    return [];
  }
}

// Directories of every open pane, to know which checkouts are in use.
function openDirs() {
  try {
    return execFileSync(TMUX_BIN, tmuxArgs('list-panes', '-a', '-F', '#{pane_current_path}'), {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

const isPaneId = (s) => typeof s === 'string' && /^%\d+$/.test(s);
const isWindowId = (s) => typeof s === 'string' && /^@\d+$/.test(s);

function sendSavedWindows(session, send, initial) {
  const windows = savedFor(session).map(pageEntry);
  send(initial ? { t: 'saved', windows, order: tabOrderFor(session) } : { t: 'saved', windows });
}

function storeTabOrder(session, order, send) {
  try {
    saveTabOrder(session, order);
  } catch (err) {
    send({ t: 'notice', text: `Could not save tab order: ${err.message}`, kind: 'bad' });
  }
}

function newWatch({ target, host, session }, send) {
  const watch = target === undefined ? watchTarget(host, session) : parseWatchInput(target);
  if (watch) return { id: newWindowId(), name: watchValue(watch), dir: os.homedir(), watch };
  send({ t: 'watch-rejected', target: typeof target === 'string' ? target.slice(0, 1024) : '', text: watchInputProblem(target) });
  return null;
}

function watchOptions(watch) {
  return [`set-option -w ${WATCH_OPTION} ${quote(watchValue(watch))}`, 'set-option -w remain-on-exit on'];
}

// A page connects. If its session is gone but windows were saved for it,
// start nothing: show the saved windows and let the page pick one to start
// the session with, or ask for an empty session.
export function attachTmuxSession(ws, opts) {
  const { session, onStop = () => {}, onRestart = () => {}, onSoftRestart = () => {} } = opts;
  const exists = (cb) => execFile(TMUX_BIN, tmuxArgs('has-session', '-t', `=${session}`), (err) => cb(!err));
  exists((yes) => {
    if (yes || !savedFor(session).length) return bridge(ws, opts);
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const onSavedChange = (s) => s === session && sendSavedWindows(session, send);
    let { cols, rows } = opts;
    let starting = false;
    const more = []; // saved windows tapped while the session was starting
    const leave = () => {
      ws.off('message', onMessage);
      ws.off('close', leave);
      savedEvents.off('change', onSavedChange);
    };
    // Another page may have started the session meanwhile; then the saved
    // window opens as a new window in it instead of as its first.
    const start = (entry) => {
      if (starting) {
        if (entry) more.push(entry);
        return;
      }
      starting = true;
      exists((now) => {
        leave();
        if (ws.readyState !== ws.OPEN) return;
        if (!entry || now) bridge(ws, { ...opts, cols, rows, reopen: [entry, ...more].filter(Boolean) });
        else bridge(ws, { ...opts, cols, rows, first: entry, reopen: more });
      });
    };
    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === 'size' && msg.cols > 1 && msg.rows > 1 && msg.cols < 2000 && msg.rows < 1000) {
        cols = Math.trunc(msg.cols);
        rows = Math.trunc(msg.rows);
      } else if (msg.t === 'tab-order') storeTabOrder(session, msg.order, send);
      else if (msg.t === 'new-session') start(null);
      else if (msg.t === 'new-watch') {
        const entry = newWatch(msg, send);
        if (entry) start(entry);
      } else if (msg.t === 'resume' && typeof msg.id === 'string') {
        const entry = takeSaved(session, msg.id);
        if (entry) start(entry);
      } else if (msg.t === 'delete-code') answerDeleteCode(msg, send);
      else if ((msg.t === 'forget' || msg.t === 'delete-remote') && typeof msg.id === 'string') forgetSaved(session, msg.id, msg.code, send);
      else if (msg.t === 'stop') onStop();
      else if (msg.t === 'restart') onRestart();
      else if (msg.t === 'soft-restart') onSoftRestart();
    }
    ws.on('message', onMessage);
    ws.on('close', leave);
    savedEvents.on('change', onSavedChange);
    sendSavedWindows(session, send, true); // ahead of idle, so the page draws the dotted tabs at once
    send({ t: 'idle', session, build: opts.build, remotes: remotesForPage() });
  });
}

// `first`: a saved window to start a new session with. `reopen`: a saved
// window to open in the (existing) session once attached.
function bridge(ws, opts) {
  const { session, commit = '', build = '', onStop = () => {}, onRestart = () => {}, onSoftRestart = () => {}, first = null, reopen = [] } = opts;
  let { cols, rows } = opts;
  const firstRemote = first?.remote ?? null;
  // A saved window to start the session with: its first pane's directory
  // now, the rest of it (panes, notes, agents) once attached.
  const firstWatch = first?.watch;
  const firstPlan = first && !firstRemote && !firstWatch ? planPanes(first) : null;
  const tmux = new TmuxControl({
    session,
    cols,
    rows,
    cwd: firstPlan?.dirs[0] ?? os.homedir(),
    windowName: first && (firstRemote || firstWatch || !first.autoName) ? first.name : null,
    command: firstRemote ? remoteCommand(firstRemote) : firstWatch ? watchCommand(firstWatch) : null,
  });
  // Ahead of every other command, so the first window keeps its saved id.
  if (first) tmux.run(`set-option -w ${ID_OPTION} ${quote(first.id)}`);
  if (firstWatch) tmux.runList(watchOptions(firstWatch));
  if (firstRemote) tmux.runList([
    `set-option -w ${REMOTE_OPTION} ${quote(remoteValue(firstRemote))}`,
    'set-option -p @dtmux_connecting 1',
  ]);
  if (firstPlan)
    tmux.run('display -p "#{window_id} #{pane_id}"', (err, lines) => {
      if (err) return;
      const [win, pane] = String(lines[0]).split(' ');
      fillWindow(first, firstPlan, win, pane);
    });
  const panes = new Map(); // pane id -> { ready }
  let view = { windows: [], panes: [] }; // the last list-windows / list-panes, for a paste's machine
  const tails = new Map(); // pane id -> recent plain text, for resume hints
  const journaled = new Set(); // resume commands already shown this connection
  let clientName = null;
  let refreshTimer = null;
  let bindings = new Map(); // prefix-table key -> command
  let prompt = null; // the binding waiting for the browser's answer
  let promptSeq = 0;

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  tmux.on('output', (paneId, data) => {
    if (trackKitty(paneId, data)) {
      tmux.run(`display -p -t ${paneId} "#{pane_current_command}"`, (err, lines) => {
        if (!err) recordKittyCommand(paneId, lines[0]);
      });
    }
    // Output before a pane's snapshot is already part of that snapshot.
    if (panes.get(paneId)?.ready) send({ t: 'out', p: paneId, d: data.toString('base64') });
    noteResume(paneId, data);
  });
  tmux.on('notify', (name, rest) => {
    // A remote tab's helper changed its window options (see remotes.js).
    if (STRUCTURAL.has(name) || (name === 'subscription-changed' && rest.startsWith('dtmux-remote '))) scheduleRefresh();
    if (name === 'pane-mode-changed' && isPaneId(rest)) leaveMode(rest);
    if (name === 'message' || name === 'config-error')
      send({ t: 'notice', text: rest, kind: name === 'message' ? '' : 'bad' });
  });
  tmux.on('stderr', (text) => console.error(`tmux[${session}]: ${text.trim()}`));
  tmux.on('exit', (reason) => {
    // Tell the page whether the session itself is gone (its last shell
    // exited) or only this client was detached, so it can offer the right fix.
    // A session that ended with saved windows left (its last window was
    // disconnected, say) goes back to idle: the dotted tabs, nothing started.
    execFile(TMUX_BIN, tmuxArgs('has-session', '-t', `=${session}`), (err) => {
      if (ws.readyState !== ws.OPEN) return;
      if (err && savedFor(session).length) {
        detach();
        attachTmuxSession(ws, { ...opts, cols, rows, first: null, reopen: [] });
        return;
      }
      send({ t: 'exit', reason, sessionGone: Boolean(err) });
      ws.close();
    });
  });

  tmux.run(`refresh-client -C ${cols}x${rows}`);
  tmux.run(`refresh-client -B ${quote(REMOTE_SUBSCRIPTION)}`);
  // Splitting a remote tab splits on its machine (see remote-keys.js). Its own
  // slot in the hook array, so a hook of your ~/.tmux.conf stays.
  tmux.run(`set-hook -g after-split-window[77] ${quote(SPLIT_HOOK)}`);
  tmux.run('display -p "#{client_name}\t#{prefix}"', (err, lines) => {
    if (err) return;
    const [name, prefix] = lines[0].split('\t');
    clientName = name;
    send({ t: 'hello', session, prefix, commit, build, remotes: remotesForPage() });
    sendSavedWindows(session, send, true);
  });
  const onSavedChange = (s) => s === session && sendSavedWindows(session, send);
  savedEvents.on('change', onSavedChange);
  const onContainer = (status) => send({ t: 'container', status });
  containerEvents.on('change', onContainer);
  loadBindings();
  refresh();
  for (const entry of reopen) openSaved(entry);

  function loadBindings() {
    tmux.run(`list-keys -T prefix -F ${quote('#{key_string}\t#{key_command}')}`, (err, lines) => {
      if (err) return;
      bindings = new Map(lines.map((l) => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]));
    });
  }

  // Run tmux key names through tmux's key tables, unless the binding would
  // open a prompt; that one is asked in the browser instead.
  function pressKeys(keys) {
    const bound = keys.length === 2 ? bindings.get(keys[1]) : null;
    const action = remoteAction(bound);
    if (action) return onRemote(action, () => runKeys(keys));
    runKeys(keys);
  }
  function runKeys(keys) {
    const wanted = keys.length === 2 ? parseBinding(bindings.get(keys[1])) : null;
    if (wanted) askBrowser(wanted);
    else {
      tmux.run(`send-keys -K -c ${quote(clientName)} ${keys.map(quote).join(' ')}`);
      watchForWedge();
    }
    loadBindings(); // the binding may have been source-file; pick up changes
  }

  function askBrowser(b) {
    const formats = b.kind === 'confirm' ? [b.prompt] : [...b.prompts, ...b.inputs];
    if (b.formatTemplate) formats.push(b.template);
    tmux.runList(
      formats.map((f) => `display -p ${quote(f)}`),
      (results) => {
        const text = results.map((r, i) => (r.err ? formats[i] : r.lines.join(' ')));
        const id = ++promptSeq;
        if (b.kind === 'confirm') {
          prompt = { id, command: b.command };
          send({
            t: 'prompt',
            id,
            kind: 'confirm',
            prompts: text,
            confirmKey: b.confirmKey,
            enterConfirms: b.enterConfirms,
          });
        } else {
          const n = b.prompts.length;
          prompt = { id, template: b.formatTemplate ? text[text.length - 1] : b.template, count: n };
          send({
            t: 'prompt',
            id,
            kind: 'prompt',
            prompts: text.slice(0, n),
            inputs: text.slice(n, n + b.inputs.length),
            single: b.single,
            numeric: b.numeric,
          });
        }
      },
    );
  }

  function answer(id, values) {
    if (!prompt || prompt.id !== id) return;
    const p = prompt;
    prompt = null;
    if (values === null) return;
    // A confirmed pane command (kill-pane) in a remote tab: the machine's.
    const action = p.command ? remoteAction(p.command) : null;
    if (action) return onRemote(action, () => runAnswer(p, values));
    runAnswer(p, values);
  }

  // In a remote tab, type `action`'s key into it (remote-keys.js);
  // elsewhere, `here()`.
  function onRemote(action, here) {
    tmux.run(`display -p -c ${quote(clientName)} ${quote('#{@dtmux_remote}\t#{pane_id}')}`, (err, lines) => {
      const [remote, pane] = err ? [] : String(lines[0] ?? '').split('\t');
      if (!remote || !pane) return here();
      tmux.run(`send-keys -t ${pane} ${actionKeys(action)}`);
    });
  }

  function runAnswer(p, values) {
    let cmd;
    if (p.command) cmd = p.command;
    else {
      if (!Array.isArray(values) || values.length !== p.count) return;
      // Control mode reads one command per line.
      cmd = fillTemplate(
        p.template,
        values.map((v) =>
          String(v)
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 4096),
        ),
      );
    }
    tmux.runLine(cmd.replace(/\n/g, ' ; '), (err, lines) => {
      if (err) send({ t: 'notice', text: err.message, kind: 'bad' });
      else if (lines.length) send({ t: 'notice', text: lines.join('\n') });
    });
  }

  function leaveMode(id) {
    tmux.run(`display -p -t ${id} "#{pane_in_mode}\t#{pane_mode}"`, (err, lines) => {
      if (err || !lines[0]?.startsWith('1')) return;
      const mode = lines[0].split('\t')[1];
      tmux.run(`copy-mode -q -t ${id}`);
      send({ t: 'notice', text: MODE_NOTICES[mode] ?? `tmux ${mode} is not shown here.` });
    });
  }

  // A binding can still open tmux UI we did not foresee (a menu, the pane
  // picker, a prompt inside something else). tmux then stops reading this
  // client's commands, so the probe below goes unanswered. Closing the
  // overlay takes a key from outside: a second, ordinary tmux command.
  function watchForWedge() {
    let answered = false;
    let tries = 0;
    const check = () => {
      if (answered || tmux.closed) return;
      if (tries === 0)
        send({
          t: 'notice',
          text: 'That tmux key opened a menu or overlay the browser cannot show, so it was closed.',
        });
      if (tries === UNWEDGE_KEYS.length) {
        send({ t: 'notice', text: 'tmux stopped responding to this page. Try reloading.', kind: 'bad' });
        return;
      }
      execFile(TMUX_BIN, tmuxArgs('send-keys', '-K', '-c', clientName, UNWEDGE_KEYS[tries++]), () => setTimeout(check, 250));
    };
    // tmux can answer a probe sent right behind the keys before the overlay
    // takes over the client, so probe a moment later.
    setTimeout(() => {
      tmux.run('display -p ""', () => (answered = true));
      setTimeout(check, 400);
    }, 150);
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 10);
  }

  function refresh() {
    tmux.runList([`list-windows -F ${quote(WINDOW_FORMAT)}`, `list-panes -s -F ${quote(PANE_FORMAT)}`], ([w, p]) => {
      if (w.err || p.err) return;
      const windows = w.lines.filter(Boolean).map((l) => {
        let [id, index, active, layout, uid, remote, watchVal, ...name] = l.split('\t');
        // Every window gets a long unique id the first time we see it, so a
        // saved window can be told apart from any other after a restart.
        if (!uid) {
          uid = newWindowId();
          tmux.run(`set-option -w -t ${id} ${ID_OPTION} ${uid}`);
        }
        const where = parseRemote(remote); // upSince: null while the VM is being made
        return { id, uid, index: Number(index), active: active === '1', layout, remote: where, watch: parseWatch(watchVal), name: name.join('\t') };
      });
      const list = p.lines.filter(Boolean).map((l) => {
        const [id, window, active, width, height, cmd] = l.split('\t');
        return { id, window, active: active === '1', width: Number(width), height: Number(height), cmd };
      });
      view = { windows, panes: list };
      send({ t: 'state', windows, panes: list });
      const live = new Set(list.map((x) => x.id));
      for (const id of panes.keys()) {
        if (!live.has(id)) {
          panes.delete(id);
          tails.delete(id);
          forgetPane(id);
        }
      }
      for (const pane of list) {
        if (!panes.has(pane.id)) {
          panes.set(pane.id, { ready: false });
          snapshot(pane.id);
        }
      }
    });
  }

  // Send a pane's scrollback, screen and terminal modes, then start streaming
  // its output. Output is paused around the capture so the snapshot and the
  // stream meet exactly, with no gap and no duplicate.
  function snapshot(id) {
    tmux.runList(
      [
        `refresh-client -A ${quote(`${id}:off`)}`,
        `display -p -t ${id} ${quote(MODE_FORMAT)}`,
        `capture-pane -p -e -S -${HISTORY_LINES} -t ${id}`,
        `capture-pane -a -p -e -q -t ${id}`,
        `refresh-client -A ${quote(`${id}:on`)}`,
      ],
      ([, modes, screen, saved]) => {
        const pane = panes.get(id);
        if (!pane) return;
        if (!modes.err && modes.lines.length)
          send({
            t: 'init',
            p: id,
            d: Buffer.from(buildInit(id, modes.lines[0], screen.lines, saved.lines)).toString('base64'),
          });
        pane.ready = true;
      },
    );
  }

  ws.on('message', onMessage);
  ws.on('close', detach);
  function detach() {
    ws.off('message', onMessage);
    ws.off('close', detach);
    savedEvents.off('change', onSavedChange);
    containerEvents.off('change', onContainer);
    clearTimeout(refreshTimer);
    tmux.close();
  }
  function onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'in':
        if (isPaneId(msg.p) && panes.has(msg.p) && typeof msg.d === 'string') {
          sendBytes(msg.p, Buffer.from(msg.d, msg.bin ? 'latin1' : 'utf8'));
        }
        break;
      case 'paste-image': {
        const pane = view.panes.find((p) => p.id === msg.p);
        const window = pane && view.windows.find((w) => w.id === pane.window);
        if (window && !window.watch && panes.has(msg.p)) placePastedImage(msg);
        break;
      }
      case 'size': {
        const c = Math.trunc(msg.cols);
        const r = Math.trunc(msg.rows);
        if (c > 1 && r > 1 && c < 2000 && r < 1000) {
          cols = c;
          rows = r;
          tmux.run(`refresh-client -C ${c}x${r}`);
        }
        break;
      }
      case 'keys':
        if (
          clientName &&
          Array.isArray(msg.keys) &&
          msg.keys.length &&
          msg.keys.every((k) => typeof k === 'string' && k.length < 32)
        ) {
          pressKeys(msg.keys);
        }
        break;
      case 'answer':
        answer(msg.id, msg.values);
        break;
      case 'select-window':
        if (isWindowId(msg.w)) tmux.run(`select-window -t ${msg.w}`);
        break;
      case 'select-pane':
        if (isPaneId(msg.p)) tmux.run(`select-pane -t ${msg.p}`);
        break;
      case 'resize-pane': {
        const size = Math.trunc(msg.size);
        const flag = msg.axis === 'x' ? '-x' : msg.axis === 'y' ? '-y' : '';
        if (flag && isPaneId(msg.p) && panes.has(msg.p) && size >= 1 && size <= 5000)
          tmux.run(`resize-pane -t ${msg.p} ${flag} ${size}`);
        break;
      }
      case 'new-window':
        tmux.run('new-window -c "#{pane_current_path}"');
        break;
      case 'new-watch': {
        const entry = newWatch(msg, send);
        if (entry) openSaved(entry);
        break;
      }
      case 'new-remote':
        if (typeof msg.name === 'string') newRemote(msg.name);
        break;
      case 'open':
        openExternal(msg.url);
        break;
      case 'resume':
        if (typeof msg.id === 'string') resumeSaved(msg.id);
        break;
      case 'tab-order':
        storeTabOrder(session, msg.order, send);
        break;
      case 'reorder':
        if (Array.isArray(msg.ws) && msg.ws.length < 1000 && msg.ws.every(isWindowId)) reorder(msg.ws);
        break;
      case 'disconnect':
        if (isWindowId(msg.w)) disconnectWindow(msg.w);
        break;
      case 'info':
        if (isWindowId(msg.w))
          tmux.run(`display -p -t ${msg.w} ${quote(`#{${REMOTE_UP_OPTION}}`)}`, (e, up) =>
            windowInfo(tmux, msg.w, (err, list) => !err && send({ t: 'info', w: msg.w, panes: list, upSince: Number(up?.[0]) || null })),
          );
        break;
      case 'delete-code':
        answerDeleteCode(msg, send);
        break;
      case 'forget':
      case 'delete-remote':
        if (isWindowId(msg.w)) closeWindow(msg.w, msg.code);
        else if (typeof msg.id === 'string') forgetSaved(session, msg.id, msg.code, send);
        break;
      case 'close':
        if (isWindowId(msg.w)) closeWindow(msg.w, msg.code);
        break;
      case 'stop':
        onStop();
        break;
      case 'restart':
        onRestart();
        break;
      case 'soft-restart':
        onSoftRestart();
        break;
      case 'rename':
        if (typeof msg.name === 'string' && msg.name.trim() && msg.name.length <= 200) {
          const name = msg.name.replace(/[\r\n\t]+/g, ' ').trim();
          if (isWindowId(msg.w)) tmux.run(`rename-window -t ${msg.w} ${quote(name)}`);
          else if (typeof msg.id === 'string') renameSaved(session, msg.id, name);
        }
        break;
      case 'gh-status':
      case 'gh-instrument':
      case 'gh-uninstrument':
        if (isWindowId(msg.w)) ghRequest(msg.t, msg.w);
        break;
      case 'settings-get':
        sendSettings();
        if (containerStatus().state === 'unknown') ensureImage({ build: false });
        break;
      case 'settings-save': {
        const r = saveConnectors(msg.remotes);
        send({ t: 'settings-saved', ok: r.ok, problems: r.problems });
        if (r.ok) {
          send({ t: 'remotes', remotes: remotesForPage() });
          sendSettings();
        }
        break;
      }
      case 'container-rebuild':
        ensureImage({ rebuild: true });
        break;
    }
  }

  function sendSettings() {
    let connectors;
    try {
      connectors = readConnectors();
    } catch (e) {
      connectors = { error: e.message };
    }
    send({ t: 'settings', connectors, container: containerStatus() });
  }

  // gh on a remote tab's machine (gh-remote.js). Each part of the answer is
  // sent as soon as it is known: { t: 'gh', w, part, ... }.
  function ghRequest(what, w) {
    tmux.run(`display -p -t ${w} ${quote(`#{window_id}\t${REMOTE_FORMAT}`)}`, async (err, lines) => {
      const reply = (part, data) => send({ t: 'gh', w, part, ...data });
      const [id, remoteVal] = err ? [] : String(lines[0] ?? '').split('\t');
      const where = id === w ? parseRemote(remoteVal) : null;
      let remote = null;
      try {
        remote = where && currentRemotes()[where.name];
      } catch {}
      if (!where || !remote) return reply('error', { error: 'This tab is not on a remote machine dtmux knows.' });
      const address = where.address ?? remote.address;
      if (!address) return reply('error', { error: `${where.host} has no address yet (still being made?).` });
      const target = [remote, where.host, address];
      if (what === 'gh-status') {
        hostStatus().then((r) => reply('host', r));
        cleanCheck().then((r) => reply('check', r));
        machineStatus(...target).then((r) => reply('machine', r));
      } else {
        reply('busy', { action: what });
        const r = await (what === 'gh-instrument' ? instrument(...target) : uninstrument(...target));
        reply('done', { action: what, ...r });
        machineStatus(...target).then((m) => reply('machine', m));
      }
    });
  }

  // Save a window the way a stop would (name, directory, long id), then
  // close it. Its tab turns dotted in place; tapping it reopens it.
  // A coding agent in it is closed first, the way you would (see
  // agent-close.js), so its resume command is saved with the window.
  const closing = new Set();
  function disconnectWindow(w) {
    if (closing.has(w)) return;
    const format = ['#{window_id}', `#{${ID_OPTION}}`, '#{automatic-rename}', '#{pane_current_path}', REMOTE_FORMAT, WATCH_FORMAT, '#{window_name}'].join('\t');
    tmux.run(`display -p -t ${w} ${quote(format)}`, async (err, lines) => {
      if (err || !lines[0]) return;
      const [id, uid, auto, dir, remoteVal, watchVal, ...name] = lines[0].split('\t');
      const remote = parseRemote(remoteVal);
      const watch = parseWatch(watchVal);
      if (id !== w) return; // tmux fell back to another window: that one is not ours to close
      closing.add(w);
      // Programs in a remote tmux keep running after the local viewer closes.
      const agents = remote || watch ? [] : await closeAgents(session, { target: w, log: (m) => console.log(`[${session}] ${m}`) });
      closing.delete(w);
      const byPane = agentsByPane(agents);
      const win = remote || watch ? null : (await listPanes(TMUX_BIN, tmuxArgs, w)).get(w);
      const agent = (win && windowAgent(win, byPane)) ?? agents.find((a) => a.active) ?? agents[0];
      const where = agent?.dir || dir;
      addSaved(session, {
        ...panesOf(win, byPane),
        id: uid || newWindowId(),
        name: name.join('\t'),
        autoName: auto === '1',
        dir: where,
        branch: remote || watch ? null : branchOf(where),
        agent: agent?.command ? { name: agent.agent, command: agent.command } : null,
        remote,
        watch,
      });
      execFile(TMUX_BIN, tmuxArgs('kill-window', '-t', w), (e, _o, stderr) => {
        if (e && !/can't find window/.test(stderr)) send({ t: 'notice', text: `Could not close the window: ${stderr.trim() || e.message}`, kind: 'bad' });
      });
    });
  }

  // Close a window for good: no dotted tab. From outside the window, so a
  // stuck one (a frozen ssh, say) closes too. A remote tab closed for good
  // takes its machine with it (Disconnect is the way to keep the machine):
  // nothing would ever join it again, and it would run on, maybe at a cost.
  // That needs the code issued for the window (see delete-codes.js).
  function closeWindow(w, code) {
    tmux.run(`display -p -t ${w} ${quote(`#{window_id}\t${REMOTE_FORMAT}`)}`, (err, lines) => {
      if (err || !lines[0]) return;
      const [id, remoteVal] = lines[0].split('\t');
      if (id !== w) return; // tmux fell back to another window: not ours to close
      const where = parseRemote(remoteVal);
      if (where && !deleteConfirmed(`w:${w}`, code, send)) return;
      execFile(TMUX_BIN, tmuxArgs('kill-window', '-t', w), (e, _o, stderr) => {
        if (e && !/can't find window/.test(stderr)) send({ t: 'notice', text: `Could not close the window: ${stderr.trim() || e.message}`, kind: 'bad' });
      });
      if (where) deleteTabMachine(where, 'Delete on its tab (code confirmed)', send);
    });
  }

  // Type an agent's resume command into a fresh pane's shell, as you would.
  function typeAgent(pane, agent) {
    if (!isPaneId(pane) || !agent?.command) return;
    tmux.runList([`send-keys -t ${pane} -l ${quote(agent.command)}`, `send-keys -t ${pane} Enter`]);
  }

  // Reopen a saved window: a new window with the saved name (unless tmux was
  // naming it after its program) in the saved directory, under the same id.
  function resumeSaved(id) {
    const entry = takeSaved(session, id);
    if (entry) openSaved(entry);
  }
  function openSaved(entry) {
    if (entry.watch) {
      tmux.runList([
        `new-window -n ${quote(entry.name)} ${quote(watchCommand(entry.watch))}`,
        `set-option -w ${ID_OPTION} ${quote(entry.id)}`,
        ...watchOptions(entry.watch),
      ], ([made]) => made.err && send({ t: 'notice', text: `Could not open watcher: ${made.err.message}`, kind: 'bad' }));
      return;
    }
    if (entry.remote) return openRemote(entry.remote, entry.id, entry.name);
    const plan = planPanes(entry);
    const name = entry.autoName ? '' : ` -n ${quote(entry.name)}`;
    // One command list, so the id is on the window before anyone lists it.
    // runList, not run: tmux answers each command of a list separately.
    tmux.runList(
      [`new-window -P -F "#{window_id} #{pane_id}" -c ${quote(plan.dirs[0])}${name}`, `set-option -w ${ID_OPTION} ${quote(entry.id)}`],
      ([made]) => {
        if (made.err) return send({ t: 'notice', text: `Could not reopen "${entry.name}": ${made.err.message}`, kind: 'bad' });
        const [win, first] = String(made.lines[0]).split(' ');
        fillWindow(entry, plan, win, first);
      },
    );
  }

  // A saved window's panes (one for most windows): each one's directory
  // (home when it is gone), its git branch put back, and what to tell.
  function planPanes(entry) {
    const saved = entry.panes?.length > 1 ? entry.panes : [{ dir: entry.dir, branch: entry.branch, agent: entry.agent }];
    const notes = []; // [pane index, { text, kind }]: shown on that pane
    const branchesDone = new Set();
    const dirs = saved.map((p, i) => {
      if (!isDir(p.dir)) {
        notes.push([i, { text: `${p.dir || 'The saved directory'} is gone; opened "${entry.name}"${saved.length > 1 ? ` (pane ${i + 1})` : ''} in your home directory.`, kind: 'bad' }]);
        return os.homedir();
      }
      if (!branchesDone.has(p.dir)) {
        branchesDone.add(p.dir);
        const text = restoreBranch(p.dir, p.branch, openDirs());
        if (text) notes.push([i, { text, kind: /^Switched/.test(text) ? '' : 'bad' }]);
      }
      return p.dir;
    });
    return { saved, dirs, notes };
  }

  // Window `win`, made with its first pane `first` in plan.dirs[0]: make the
  // other panes, put the layout back, then tell the notes and resume each
  // pane's agent.
  function fillWindow(entry, { saved, dirs, notes }, win, first) {
    const ids = [first];
    const finish = () => {
      const cmds = [];
      if (ids.length === dirs.length && ids.length > 1 && entry.layout) cmds.push(`select-layout -t ${win} ${quote(entry.layout)}`);
      if (ids.length > 1) cmds.push(`select-pane -t ${ids[entry.activePane] ?? first}`);
      const after = () => {
        for (const [i, note] of notes) if (ids[i]) send({ t: 'notice', ...note, p: ids[i] });
        saved.forEach((p, i) => ids[i] && typeAgent(ids[i], p.agent));
      };
      if (cmds.length) tmux.runList(cmds, after);
      else after();
    };
    // One split at a time, after the last pane made, so tmux lists the panes
    // in their saved order (the order the layout gives them out); evened out
    // each time, so many panes still fit.
    const next = () => {
      if (ids.length >= dirs.length) return finish();
      tmux.runList(
        [`split-window -d -P -F "#{pane_id}" -t ${ids[ids.length - 1]} -c ${quote(dirs[ids.length])}`, `select-layout -t ${win} tiled`],
        ([split]) => {
          if (split.err) {
            send({ t: 'notice', text: `"${entry.name}" came back with ${ids.length} of its ${dirs.length} panes: ${split.err.message}`, kind: 'bad', p: first });
            return finish();
          }
          ids.push(String(split.lines[0]).trim());
          next();
        },
      );
    };
    next();
  }

  // A tab on a VM: `create` makes the VM (a new tab), else it is joined.
  function openRemote(where, id, name, { create = false } = {}) {
    tmux.runList(
      [
        `new-window -P -F "#{pane_id}" -c ${quote(os.homedir())} -n ${quote(name)} ${quote(remoteCommand(where, { create }))}`,
        `set-option -w ${ID_OPTION} ${quote(id)}`,
        `set-option -w ${REMOTE_OPTION} ${quote(remoteValue(where))}`,
        'set-option -p @dtmux_connecting 1',
      ],
      ([made]) => made.err && send({ t: 'notice', text: `Could not open "${name}": ${made.err.message}`, kind: 'bad' }),
    );
  }
  function newRemote(name) {
    let remote;
    try {
      remote = currentRemotes()[name];
    } catch (err) {
      return send({ t: 'notice', text: err.message, kind: 'bad' });
    }
    if (!remote) return send({ t: 'notice', text: `No remote "${name}" in ~/.dtmux.yaml any more.`, kind: 'bad' });
    const host = newHost(remote);
    openRemote({ name, host }, newWindowId(), host, { create: true });
  }

  // Swap windows until tmux's index order matches the page's tab order, so
  // prefix + digit and the next stop's saved order follow the tabs.
  function reorder(wanted) {
    tmux.run(`list-windows -F ${quote('#{window_id}\t#{window_index}\t#{window_active}')}`, (err, lines) => {
      if (err) return;
      const current = lines.filter(Boolean).map((l) => {
        const [id, index, active] = l.split('\t');
        return { id, index: Number(index), active: active === '1' };
      });
      const swaps = planSwaps(current, wanted);
      if (!swaps.length) return;
      // Swapping moves windows between indexes, and the current window is an
      // index; select the one that was current again.
      const active = current.find((w) => w.active);
      const cmds = swaps.map(([a, b]) => `swap-window -d -s ${a} -t ${b}`);
      if (active) cmds.push(`select-window -t ${active.id}`);
      tmux.runList(cmds, () => scheduleRefresh());
    });
  }

  // A resume command printed on the pane becomes a bubble. Nothing is stored.
  function noteResume(paneId, data) {
    const prev = tails.get(paneId) ?? '';
    const next = (prev + data.toString('utf8')).slice(-4000);
    tails.set(paneId, next);
    const hint = findResumeHint(next);
    if (!hint) return;
    // Used up: the next agent to leave in this pane must not be shadowed by
    // this one, still sitting in the recent text.
    tails.set(paneId, '');
    if (journaled.has(hint.command)) return;
    journaled.add(hint.command);
    tmux.run(`display -p -t ${paneId} "#{pane_current_path}"`, (err, lines) => {
      const cwd = err ? '' : lines[0];
      send({ t: 'journal', p: paneId, agent: hint.agent, command: hint.command, ...placeOf(cwd) });
    });
  }

  // A screenshot from the page: keep it on this Mac, and on the machine too
  // when the pane's shell is there, then tell the page the path to type.
  function placePastedImage(msg) {
    const fail = (error) => send({ t: 'paste-path', p: msg.p, error });
    if (typeof msg.data !== 'string' || msg.data.length === 0 || msg.data.length > 16_000_000) {
      fail('That image is too large to paste.');
      return;
    }
    let local;
    try {
      local = savePastedImage(Buffer.from(msg.data, 'base64'), pasteDir());
    } catch (e) {
      fail(e.message);
      return;
    }
    const pane = view.panes.find((p) => p.id === msg.p);
    const where = view.windows.find((w) => w.id === pane?.window)?.remote;
    if (!where) {
      send({ t: 'paste-path', p: msg.p, path: local });
      return;
    }
    if (where.ended || !where.address) {
      fail('That machine is not connected, so the image was not pasted.');
      return;
    }
    let remote;
    try {
      remote = currentRemotes()[where.name];
    } catch (e) {
      fail(e.message);
      return;
    }
    if (!remote) {
      fail(`No remote "${where.name}" in ~/.dtmux.yaml, so the image was not pasted.`);
      return;
    }
    uploadPaste(remote, where.host, where.address, local).then(
      (path) => send({ t: 'paste-path', p: msg.p, path }),
      (e) => fail(e.message),
    );
  }

  // Raw bytes into a pane, bypassing tmux's key handling. xterm.js has already
  // encoded them for whatever modes the program in the pane asked for.
  function sendBytes(id, bytes) {
    for (let i = 0; i < bytes.length; i += SEND_CHUNK) {
      tmux.run(paneInputCommand(id, bytes.subarray(i, i + SEND_CHUNK)));
    }
  }
}

// Evaluate the guard in tmux at delivery time; its helper may have reconnected.
export function paneInputCommand(id, bytes) {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const keys = `send-keys -H -t ${id} ${hex}`;
  if (bytes.length === 1 && (bytes[0] === 3 || bytes[0] === 4))
    return `if-shell -F -t ${id} '#{&&:#{==:${WATCH_FORMAT},},#{!=:#{@dtmux_connecting},1}}' ${quote(keys)}`;
  return `if-shell -F -t ${id} '#{==:${WATCH_FORMAT},}' ${quote(keys)}`;
}

// The swap-window pairs that put `current` windows ({ id, index }) into the
// order of `wanted` (window ids). Windows `wanted` does not name keep their
// relative order after the named ones; ids tmux does not have are ignored.
export function planSwaps(current, wanted) {
  const have = new Set(current.map((w) => w.id));
  const named = [...new Set(wanted.filter((id) => have.has(id)))];
  const order = [...named, ...current.filter((w) => !named.includes(w.id)).sort((a, b) => a.index - b.index).map((w) => w.id)];
  const slots = current.map((w) => w.index).sort((a, b) => a - b);
  const at = new Map(current.map((w) => [w.index, w.id]));
  const where = new Map(current.map((w) => [w.id, w.index]));
  const swaps = [];
  order.forEach((id, i) => {
    const slot = slots[i];
    const other = at.get(slot);
    if (other === id) return;
    const from = where.get(id);
    swaps.push([id, other]);
    at.set(slot, id);
    at.set(from, other);
    where.set(id, slot);
    where.set(other, from);
  });
  return swaps;
}

// Directory, branch, commit, and dirty flag for the bubble. `dir` is all
// that comes back when the pane is not inside a git checkout.
function isDir(p) {
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function placeOf(cwd) {
  const home = os.homedir();
  const dir = !cwd ? '' : cwd === home ? '~' : cwd.startsWith(home + path.sep) ? `~${cwd.slice(home.length)}` : cwd;
  const git = { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    if (!cwd) return { dir };
    execFileSync('git', ['rev-parse', '--show-toplevel'], git);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], git).trim();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], git).trim().slice(0, 7);
    const dirty = execFileSync('git', ['status', '--porcelain'], git).trim() !== '';
    return { dir, branch, commit, dirty };
  } catch {
    return { dir };
  }
}

// Rebuild a pane's state in a fresh terminal of the pane's exact size.
function buildInit(id, modeLine, screenLines, savedLines) {
  const [alt, cx, cy, cursorOn, keypad, mStd, mBtn, mAny, mSgr, paste, cmd] = modeLine.split('\t');
  let s = '';
  if (alt === '1') {
    // The normal screen is saved while a full-screen program runs.
    s += savedLines.join('\r\n') + '\x1b[0m\x1b[?1049h\x1b[H' + screenLines.join('\r\n');
  } else {
    s += screenLines.join('\r\n');
  }
  s += `\x1b[0m\x1b[${Number(cy) + 1};${Number(cx) + 1}H`;
  if (cursorOn === '0') s += '\x1b[?25l';
  if (keypad === '1') s += '\x1b[?1h';
  if (mStd === '1') s += '\x1b[?1000h';
  if (mBtn === '1') s += '\x1b[?1002h';
  if (mAny === '1') s += '\x1b[?1003h';
  if (mSgr === '1') s += '\x1b[?1006h';
  if (paste === '1') s += '\x1b[?2004h';
  s += kittyRestoreSequence(id, cmd);
  return s;
}
