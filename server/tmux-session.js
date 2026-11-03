// Bridges one browser connection to a tmux session in control mode.
//
// Each tmux pane becomes its own xterm.js terminal in the browser, so the
// browser holds the real scrollback and scrolling never round-trips to tmux.
// Messages to the browser, all JSON:
//   hello  { session, prefix, commit, build }  once attached; `build` fingerprints
//                                         the page's files, see app.js
//   state  { windows, panes }             after any structural change; each
//                                         window carries its long id as `uid`
//   init   { p, d }                       a pane's history and modes, base64
//   out    { p, d }                       pane output, base64
//   exit   { reason, sessionGone }        tmux detached or the session ended
//   prompt { id, kind, prompts, inputs, single, numeric, confirmKey, enterConfirms }
//                                         a binding wants an answer (see tmux-bindings.js)
//   notice { text, kind? }                tmux messages, command output, things we undid
//   journal { agent, command, dir, branch, commit, dirty }
//                                         a resume command showed up on a pane
//   saved  { windows: [{ id, name, dir }] }
//                                         windows saved when dtmux last stopped
//   idle   { session, build }             the session does not exist but saved
//                                         windows do: nothing is started until
//                                         the page sends resume or new-session
// Messages from the browser:
//   in     { p, d, bin? }   bytes for a pane (xterm.js onData / onBinary)
//   size   { cols, rows }   the browser's grid size for the whole session
//   keys   { keys }         tmux key names routed through tmux key bindings
//   answer { id, values }   the reply to a prompt; values null when cancelled
//   select-window { w }, select-pane { p }, new-window, open { url }
//   resize-pane { p, axis, size }  drag a border; axis "x" (width) or "y" (height)
//   resume { id }          reopen a saved window: same name, same directory
//   reorder { ws }         put tmux's windows in this order (window ids, a tab drag)
//   info { w }             what the tab's tooltip shows, answered with
//                          info { w, panes: [{ id, active, dir, openSecs, running }] }
//   disconnect { w }       save a window for later and close it: it turns dotted
//   forget { id }          drop a saved window for good
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
import { savedFor, takeSaved, addSaved, savedEvents, newWindowId, ID_OPTION } from './saved-windows.js';

const HISTORY_LINES = 10000; // keep in sync with the browser's scrollback
const SEND_CHUNK = 256; // bytes per send-keys command

const WINDOW_FORMAT = [
  '#{window_id}',
  '#{window_index}',
  '#{window_active}',
  '#{window_visible_layout}',
  `#{${ID_OPTION}}`,
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
const pageEntry = ({ id, name, dir, branch, agent }) => ({ id, name, dir, branch: branch ?? null, agent: agent ?? null });

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

// A page connects. If its session is gone but windows were saved for it,
// start nothing: show the saved windows and let the page pick one to start
// the session with, or ask for an empty session.
export function attachTmuxSession(ws, opts) {
  const { session, onStop = () => {}, onRestart = () => {}, onSoftRestart = () => {} } = opts;
  const exists = (cb) => execFile(TMUX_BIN, tmuxArgs('has-session', '-t', `=${session}`), (err) => cb(!err));
  exists((yes) => {
    if (yes || !savedFor(session).length) return bridge(ws, opts);
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const sendSaved = () =>
      send({ t: 'saved', windows: savedFor(session).map(pageEntry) });
    const onSavedChange = (s) => s === session && sendSaved();
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
      } else if (msg.t === 'new-session') start(null);
      else if (msg.t === 'resume' && typeof msg.id === 'string') {
        const entry = takeSaved(session, msg.id);
        if (entry) start(entry);
      } else if (msg.t === 'forget' && typeof msg.id === 'string') takeSaved(session, msg.id);
      else if (msg.t === 'stop') onStop();
      else if (msg.t === 'restart') onRestart();
      else if (msg.t === 'soft-restart') onSoftRestart();
    }
    ws.on('message', onMessage);
    ws.on('close', leave);
    savedEvents.on('change', onSavedChange);
    sendSaved(); // ahead of idle, so the page draws the dotted tabs at once
    send({ t: 'idle', session, build: opts.build });
  });
}

// `first`: a saved window to start a new session with. `reopen`: a saved
// window to open in the (existing) session once attached.
function bridge(ws, opts) {
  const { session, commit = '', build = '', onStop = () => {}, onRestart = () => {}, onSoftRestart = () => {}, first = null, reopen = [] } = opts;
  let { cols, rows } = opts;
  const firstDir = first && (isDir(first.dir) ? first.dir : os.homedir());
  const firstBranchNote = first && firstDir === first.dir ? restoreBranch(firstDir, first.branch, openDirs()) : null;
  const tmux = new TmuxControl({
    session,
    cols,
    rows,
    cwd: firstDir || os.homedir(),
    windowName: first && !first.autoName ? first.name : null,
  });
  // Ahead of every other command, so the first window keeps its saved id.
  if (first) tmux.run(`set-option -w ${ID_OPTION} ${quote(first.id)}`);
  if (first?.agent) tmux.run('display -p "#{pane_id}"', (err, lines) => !err && typeAgent(lines[0], first.agent));
  const panes = new Map(); // pane id -> { ready }
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
    if (STRUCTURAL.has(name)) scheduleRefresh();
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
  tmux.run('display -p "#{client_name}\t#{prefix}"', (err, lines) => {
    if (err) return;
    const [name, prefix] = lines[0].split('\t');
    clientName = name;
    send({ t: 'hello', session, prefix, commit, build });
    sendSaved();
  });
  const sendSaved = () =>
    send({ t: 'saved', windows: savedFor(session).map(pageEntry) });
  const onSavedChange = (s) => s === session && sendSaved();
  savedEvents.on('change', onSavedChange);
  loadBindings();
  refresh();
  for (const entry of reopen) openSaved(entry);
  if (first && firstDir !== first.dir)
    send({ t: 'notice', text: `${first.dir || 'The saved directory'} is gone; opened "${first.name}" in your home directory.`, kind: 'bad' });
  if (firstBranchNote) send({ t: 'notice', text: firstBranchNote, kind: /^Switched/.test(firstBranchNote) ? '' : 'bad' });

  function loadBindings() {
    tmux.run(`list-keys -T prefix -F ${quote('#{key_string}\t#{key_command}')}`, (err, lines) => {
      if (err) return;
      bindings = new Map(lines.map((l) => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]));
    });
  }

  // Run tmux key names through tmux's key tables, unless the binding would
  // open a prompt; that one is asked in the browser instead.
  function pressKeys(keys) {
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
        let [id, index, active, layout, uid, ...name] = l.split('\t');
        // Every window gets a long unique id the first time we see it, so a
        // saved window can be told apart from any other after a restart.
        if (!uid) {
          uid = newWindowId();
          tmux.run(`set-option -w -t ${id} ${ID_OPTION} ${uid}`);
        }
        return { id, uid, index: Number(index), active: active === '1', layout, name: name.join('\t') };
      });
      const list = p.lines.filter(Boolean).map((l) => {
        const [id, window, active, width, height, cmd] = l.split('\t');
        return { id, window, active: active === '1', width: Number(width), height: Number(height), cmd };
      });
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
      case 'open':
        openExternal(msg.url);
        break;
      case 'resume':
        if (typeof msg.id === 'string') resumeSaved(msg.id);
        break;
      case 'reorder':
        if (Array.isArray(msg.ws) && msg.ws.length < 1000 && msg.ws.every(isWindowId)) reorder(msg.ws);
        break;
      case 'disconnect':
        if (isWindowId(msg.w)) disconnectWindow(msg.w);
        break;
      case 'info':
        if (isWindowId(msg.w)) windowInfo(tmux, msg.w, (err, list) => !err && send({ t: 'info', w: msg.w, panes: list }));
        break;
      case 'forget':
        if (typeof msg.id === 'string') takeSaved(session, msg.id);
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
    }
  }

  // Save a window the way a stop would (name, directory, long id), then
  // close it. Its tab turns dotted in place; tapping it reopens it.
  // A coding agent in it is closed first, the way you would (see
  // agent-close.js), so its resume command is saved with the window.
  const closing = new Set();
  function disconnectWindow(w) {
    if (closing.has(w)) return;
    const format = ['#{window_id}', `#{${ID_OPTION}}`, '#{automatic-rename}', '#{pane_current_path}', '#{window_name}'].join('\t');
    tmux.run(`display -p -t ${w} ${quote(format)}`, async (err, lines) => {
      if (err || !lines[0]) return;
      const [id, uid, auto, dir, ...name] = lines[0].split('\t');
      if (id !== w) return; // tmux fell back to another window: that one is not ours to close
      closing.add(w);
      const agents = await closeAgents(session, { target: w, log: (m) => console.log(`[${session}] ${m}`) });
      closing.delete(w);
      const agent = agents.find((a) => a.active) ?? agents[0];
      const where = agent?.dir || dir;
      addSaved(session, {
        id: uid || newWindowId(),
        name: name.join('\t'),
        autoName: auto === '1',
        dir: where,
        branch: branchOf(where),
        agent: agent?.command ? { name: agent.agent, command: agent.command } : null,
      });
      execFile(TMUX_BIN, tmuxArgs('kill-window', '-t', w), (e, _o, stderr) => {
        if (e && !/can't find window/.test(stderr)) send({ t: 'notice', text: `Could not close the window: ${stderr.trim() || e.message}`, kind: 'bad' });
      });
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
    let dir = entry.dir;
    if (!isDir(dir)) {
      send({ t: 'notice', text: `${dir || 'The saved directory'} is gone; opened "${entry.name}" in your home directory.`, kind: 'bad' });
      dir = os.homedir();
    }
    else {
      const note = restoreBranch(dir, entry.branch, openDirs());
      if (note) send({ t: 'notice', text: note, kind: /^Switched/.test(note) ? '' : 'bad' });
    }
    const name = entry.autoName ? '' : ` -n ${quote(entry.name)}`;
    // One command list, so the id is on the window before anyone lists it.
    // runList, not run: tmux answers each command of a list separately.
    tmux.runList(
      [`new-window -P -F "#{pane_id}" -c ${quote(dir)}${name}`, `set-option -w ${ID_OPTION} ${quote(entry.id)}`],
      ([made]) => {
        if (made.err) send({ t: 'notice', text: `Could not reopen "${entry.name}": ${made.err.message}`, kind: 'bad' });
        else typeAgent(made.lines[0], entry.agent);
      },
    );
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
      send({ t: 'journal', agent: hint.agent, command: hint.command, ...placeOf(cwd) });
    });
  }

  // Raw bytes into a pane, bypassing tmux's key handling. xterm.js has already
  // encoded them for whatever modes the program in the pane asked for.
  function sendBytes(id, bytes) {
    for (let i = 0; i < bytes.length; i += SEND_CHUNK) {
      const hex = Array.from(bytes.subarray(i, i + SEND_CHUNK), (b) => b.toString(16).padStart(2, '0'));
      tmux.run(`send-keys -H -t ${id} ${hex.join(' ')}`);
    }
  }
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
