// tmux mode (the default): the page is a tmux control-mode client.
//
// Every tmux pane gets its own xterm.js terminal, placed where tmux's layout
// puts it, and each tmux window is a tab. Pane output streams into the
// terminals, so scrollback lives in the browser and the mouse wheel scrolls
// locally with no round trip. Keystrokes go to the pane as raw bytes, encoded
// by xterm.js for whatever the program asked for (Shift+Enter included). The
// tmux prefix key is the exception: prefix sequences go through tmux's own
// key bindings, so splits, new windows and the rest keep working.
import { createTerminal, leaveQueriesToTmux, base64ToBytes, socketUrl } from './terminal-common.js';
import { followTmuxOrder, orderTabs, parseLayout, paneBorders, tmuxKeyName, windowSwitchDirection } from './tmux-util.js';

export function startTmuxMode({ container, toolbar, params }) {
  const stage = document.createElement('div');
  stage.className = 'tmux-stage';
  container.append(stage);

  const panes = new Map(); // pane id -> { term, el }
  const windowEls = new Map(); // window id -> element
  const cell = measureCell(stage);
  let grid = gridSize();
  let ws = null;
  let ended = false; // the server said goodbye; the socket closing is expected
  let taken = false; // a newer page has the session (see showTaken)
  const TAKEN_CODE = 4001; // keep in sync with server/app.js
  let sessionName = params.get('session') || 'dtmux';
  let activeWindow = null;
  // Toolbar tabs. Live windows, and windows saved when dtmux last stopped
  // (dotted until tapped, which reopens them). A tapped one is pending until
  // its window shows up, and keeps its place meanwhile. Tabs are keyed by the
  // window's long id, which a saved window keeps when reopened, and ordered by
  // `tabOrder`: the user's drag-and-drop order, remembered in this browser.
  let liveWindows = [];
  let savedWindows = [];
  let remotes = []; // [{ name, label, color, noun, lifetime, paid, plan }] from ~/.dtmux.yaml
  const pending = new Map(); // long id -> saved window, tapped, not live yet
  let haveState = false; // false while (re)connecting: the old tabs stay put, dimmed
  let draggingTab = false;
  const ORDER_KEY = `dtmux.tabOrder.${params.get('session') || ''}`;
  let tabOrder = loadOrder();
  const tabEls = new Map(); // key -> button
  const tabInfo = new Map(); // window id -> { panes, at }: the tooltip's facts, fetched on hover
  const closingTabs = new Set(); // keys of tabs being disconnected (their agent is asked to quit first)
  let activePane = null;
  let prefix = null; // tmux key name, e.g. "C-a"
  let prefixArmed = false;
  const swallowedKeyUps = new Set();

  // While the daemon is unreachable: { tries, countEl }. Loopback is cheap,
  // so retry often and come back as soon as the daemon does.
  const RETRY_MS = 333;
  let retry = null;

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const openExternal = (url) => send({ t: 'open', url });

  function connect() {
    ended = false;
    const query = { cols: grid.cols, rows: grid.rows };
    if (params.get('session')) query.session = params.get('session');
    ws = new WebSocket(socketUrl(query));
    ws.onopen = () => {
      if (retry) {
        clearTimeout(retry.overlayTimer);
        stage.querySelector('.tmux-overlay')?.remove();
      }
      retry = null;
      restartButton.disabled = false; // "+" waits for hello: an idle page has no session yet
      toolbar.setStatus('connected', 'ok');
    };
    ws.onclose = (ev) => {
      if (ev.code === TAKEN_CODE) showTaken();
      else if (!ended) retryConnect(ev.reason);
    };
    ws.onerror = () => {
      if (!retry) toolbar.setStatus('error', 'bad');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.t) {
        case 'idle':
          if (reloadIfStale(msg.build)) return;
          setRemotes(msg.remotes);
          showIdle(msg.session);
          break;
        case 'hello':
          if (reloadIfStale(msg.build)) return;
          stage.querySelector('.tmux-overlay.idle')?.remove();
          newWindowButton.disabled = false;
          setRemotes(msg.remotes);
          prefix = msg.prefix && msg.prefix !== 'None' ? msg.prefix : null;
          sessionName = msg.session;
          toolbar.setStatus(params.get('session') ? `dtmux · ${msg.session}` : 'dtmux', 'brand');
          const commit = msg.commit || document.getElementById('status').dataset.commit;
          toolbar.setTitle(
            `tmux session "${msg.session}" · prefix ${prefix ?? 'none'} · ${grid.cols}×${grid.rows}${commit ? ` · ${commit}` : ''}`,
          );
          break;
        case 'state':
          applyState(msg);
          break;
        case 'init':
          // A terminal kept across a reconnect starts over from the snapshot.
          panes.get(msg.p)?.term.reset();
          panes.get(msg.p)?.term.write(base64ToBytes(msg.d));
          break;
        case 'out':
          panes.get(msg.p)?.term.write(base64ToBytes(msg.d));
          break;
        case 'prompt':
          showPrompt(msg);
          break;
        case 'notice':
          showNotice(msg.text, msg.kind, msg.p);
          break;
        case 'journal':
          showJournal(msg);
          break;
        case 'info':
          tabInfo.set(msg.w, { panes: msg.panes, upSince: msg.upSince ?? null, at: Date.now() });
          renderTabs();
          break;
        case 'saved':
          savedWindows = Array.isArray(msg.windows) ? msg.windows : [];
          renderTabs();
          break;
        case 'taken':
          showTaken();
          break;
        case 'exit':
          ended = true;
          if (msg.sessionGone) showEnded('session ended', `Session "${sessionName}" ended.`, 'Start a new session');
          else showEnded('detached', `Detached from session "${sessionName}" (${msg.reason}).`, 'Reattach');
          break;
      }
    };
  }

  // The files on disk changed since this page loaded them (a soft restart to
  // new code, or just an edit): load them. Nothing is lost, since everything
  // lives in tmux and the tab order in localStorage. At most once in 10 s, so
  // files still being written cannot make it loop.
  function reloadIfStale(build) {
    const mine = document.getElementById('status').dataset.build;
    if (!build || !mine || mine.startsWith('__') || build === mine) return false;
    try {
      const last = Number(sessionStorage.getItem('dtmux.reloadedAt')) || 0;
      if (Date.now() - last < 10000) return false;
      sessionStorage.setItem('dtmux.reloadedAt', String(Date.now()));
    } catch {}
    ended = true; // the socket closing now is ours
    ws.close();
    location.reload();
    return true;
  }

  // The daemon went away (restarting, stopped, crashed): drop the dead panes,
  // keep the tabs where they are, dimmed, and keep retrying on our own. Only
  // if that takes a while, say how to start the daemon again; a restart is
  // usually back before then.
  const OVERLAY_DELAY_MS = 1500;
  function retryConnect(reason) {
    if (!retry) {
      // The panes stay on screen, dimmed: after a soft restart the same tmux
      // panes come back and these terminals pick up where they were.
      resetView({ keepPanes: true });
      newWindowButton.disabled = true;
      restartButton.disabled = true;
      const restarting = reason === 'dtmux restarting';
      const stopped = reason === 'dtmux stopping';
      toolbar.setStatus(restarting ? 'restarting…' : stopped ? 'stopped' : 'reconnecting…', restarting ? '' : 'bad');
      retry = { tries: 0, countEl: document.createElement('p') };
      retry.overlayTimer = setTimeout(() => showRetryOverlay(stopped || restarting), restarting ? OVERLAY_DELAY_MS * 2 : OVERLAY_DELAY_MS);
    }
    retry.tries++;
    retry.countEl.textContent = `attempt ${retry.tries}`;
    setTimeout(connect, RETRY_MS);
  }
  function showRetryOverlay(stopped) {
    if (!retry) return;
    dropPanes();
    {
      const { countEl } = retry;
      const box = document.createElement('div');
      box.className = 'tmux-overlay';
      const lost = document.createElement('p');
      lost.textContent = stopped
        ? 'dtmux is not running. Its windows are saved and come back as dotted tabs once it runs again. Reconnecting by itself, three times a second.'
        : 'Lost the connection to the dtmux daemon. Reconnecting by itself, three times a second.';
      countEl.className = 'muted';
      const hint = document.createElement('p');
      hint.textContent = 'If the daemon is stopped, start it again:';
      const cmd = document.createElement('div');
      cmd.className = 'command';
      const code = document.createElement('code');
      code.textContent = document.getElementById('status').dataset.startCmd || 'dtmux';
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
      cmd.append(code, copy);
      box.append(lost, countEl, hint, cmd);
      stage.append(box);
    }
  }

  // The session does not exist, but windows were saved when dtmux stopped:
  // start nothing. The saved windows are dotted tabs above; clicking one
  // starts the session with it. Or start the session empty from here.
  function showIdle(session) {
    sessionName = session;
    // The session can end under a connected page (its last window was
    // disconnected): drop its panes, keep the tabs.
    dropPanes();
    liveWindows = [];
    activeWindow = null;
    activePane = null;
    newWindowButton.disabled = true;
    toolbar.setStatus(params.get('session') ? `dtmux · ${session}` : 'dtmux', 'brand');
    haveState = true;
    renderTabs();
    stage.querySelector('.tmux-overlay.idle')?.remove();
    const box = document.createElement('div');
    box.className = 'tmux-overlay idle';
    const p = document.createElement('p');
    p.textContent = 'Tap a dotted tab to reopen it in its directory.';
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Start an empty session';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      send({ t: 'new-session' });
    });
    box.append(p, btn);
    stage.append(box);
    btn.focus();
  }

  // A newer page (another browser, or another tab of this one) took the
  // session. This page lets go of everything, tabs included, so the two can
  // never disagree about them, and offers to take the session back.
  function showTaken() {
    if (taken) return;
    taken = true;
    ended = true;
    clearTimeout(retry?.timer);
    clearTimeout(retry?.overlayTimer);
    retry = null;
    resetView();
    for (const el of tabEls.values()) el.remove();
    tabEls.clear();
    tabItems = new Map();
    savedWindows = [];
    pending.clear();
    newWindowButton.disabled = true;
    restartButton.disabled = true;
    toolbar.setStatus('open elsewhere', 'bad');
    const box = document.createElement('div');
    box.className = 'tmux-overlay taken';
    const p = document.createElement('p');
    p.textContent = `Session "${sessionName ?? params.get('session') ?? 'dtmux'}" is open in another page or browser.`;
    const btn = document.createElement('button');
    btn.textContent = 'Switch to this page';
    btn.addEventListener('click', () => {
      box.remove();
      taken = false;
      toolbar.setStatus('connecting…');
      connect();
    });
    box.append(p, btn);
    stage.append(box);
    btn.focus();
  }

  // The session is gone or we lost it: drop the dead panes and offer a way back.
  function showEnded(status, text, label) {
    resetView();
    newWindowButton.disabled = true;
    restartButton.disabled = true;
    toolbar.setStatus(status, 'bad');
    const box = document.createElement('div');
    box.className = 'tmux-overlay';
    const p = document.createElement('p');
    p.textContent = text;
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      box.remove();
      toolbar.setStatus('connecting…');
      connect();
    });
    box.append(p, btn);
    stage.append(box);
    btn.focus(); // Enter or Space starts it
  }

  function dropPanes() {
    stage.classList.remove('stale');
    for (const pane of panes.values()) pane.term.dispose();
    panes.clear();
    for (const el of windowEls.values()) el.remove();
    windowEls.clear();
  }

  function resetView({ keepPanes = false } = {}) {
    if (keepPanes) stage.classList.add('stale');
    else dropPanes();
    closeTabMenu();
    hideTip();
    stage.querySelector('.tmux-overlay')?.remove();
    closePrompt?.(null);
    for (const el of stage.querySelectorAll('.tmux-notice, .tmux-journal')) el.remove();
    // The tabs stay, dimmed, until the next state replaces them in place.
    haveState = false;
    toolbar.tabs.classList.add('offline');
    liveWindows = [];
    savedWindows = [];
    pending.clear();
    activeWindow = null;
    activePane = null;
    swallowedKeyUps.clear();
    setPrefixArmed(false);
  }

  // tmux's command prompt and confirmations, drawn here in place of tmux's
  // status line, which control mode does not have. The answer goes back to
  // the server, which runs the binding's command.
  let closePrompt = null;
  function showPrompt({ id, kind, prompts, inputs = [], single, numeric, confirmKey, enterConfirms }) {
    closePrompt?.(null);
    const bar = document.createElement('form');
    bar.className = 'tmux-prompt';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (numeric) input.inputMode = 'numeric';
    bar.append(label, input);
    stage.append(bar);
    const values = [];
    const step = () => {
      label.textContent = prompts[values.length] + ' ';
      input.value = kind === 'confirm' ? '' : (inputs[values.length] ?? '');
    };
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      closePrompt = null;
      bar.remove();
      send({ t: 'answer', id, values: answer });
      panes.get(activePane)?.term.focus();
    };
    closePrompt = finish;
    const next = () => {
      values.push(input.value);
      if (values.length === prompts.length) finish(values);
      else step();
    };
    if (kind === 'confirm') {
      input.readOnly = true;
      input.addEventListener('keydown', (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        finish(e.key === confirmKey || (enterConfirms && e.key === 'Enter') ? [] : null);
      });
    } else {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      });
      input.addEventListener('input', () => {
        if (numeric) input.value = input.value.replace(/\D/g, '');
        if (single && input.value) next();
      });
    }
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      if (kind !== 'confirm') next();
    });
    input.addEventListener('blur', () => setTimeout(() => finish(null)));
    step();
    input.focus();
    input.select();
  }

  // Notices (a reopened window's branch, say) show at the top, out of the way
  // of the prompt typed into at the bottom; resume bubbles at the bottom.
  // Both go in 3 s, or on a click.
  const POPUP_MS = 3000;

  const JOURNAL = {
    claude: 'Claude resume session journaled',
    codex: 'Codex resume session journaled',
    cursor: 'Cursor agent resume session journaled',
  };
  function showJournal({ p, agent, command, dir, branch, commit, dirty }) {
    for (const old of stage.querySelectorAll('.tmux-journal')) old.remove();
    const el = document.createElement('div');
    el.className = 'tmux-journal';
    const title = document.createElement('strong');
    title.textContent = JOURNAL[agent] ?? 'Resume session journaled';
    el.append(title);
    if (dir) {
      const where = document.createElement('div');
      where.textContent = dir;
      el.append(where);
    }
    if (branch || commit) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [branch, commit, dirty ? 'dirty' : 'clean'].filter(Boolean).join(' · ');
      el.append(meta);
    }
    if (command) {
      const cmd = document.createElement('code');
      cmd.textContent = command;
      el.append(cmd);
      el.title = 'Click to copy the resume command';
    }
    el.addEventListener('click', () => {
      if (command) navigator.clipboard?.writeText(command).catch(() => {});
      el.remove();
    });
    placePopup(el, p);
    setTimeout(() => el.remove(), POPUP_MS);
  }

  // A popup about a tab (pane `p`) lives in that tab's window: hidden with
  // it, and gone once you switch away (see applyState). A brand-new pane may
  // not be on the page yet; it gets a moment to arrive. Others: on the stage.
  function placePopup(el, p, tries = 0) {
    const win = p && panes.get(p)?.el.parentElement;
    if (win) return win.append(el);
    if (p && tries < 10) return setTimeout(() => placePopup(el, p, tries + 1), 100);
    stage.append(el);
  }

  function showNotice(text, kind = '', p = null) {
    if (!text) return;
    for (const old of stage.querySelectorAll('.tmux-notice')) old.remove();
    const el = document.createElement('div');
    el.className = `tmux-notice ${kind}`;
    el.textContent = text;
    el.title = 'Click to dismiss';
    el.addEventListener('click', () => el.remove());
    placePopup(el, p);
    setTimeout(() => el.remove(), POPUP_MS);
  }

  function applyState({ windows, panes: list }) {
    const layout = new Map();
    for (const w of windows) for (const leaf of parseLayout(w.layout)) layout.set(leaf.id, leaf);

    const liveIds = new Set(windows.map((w) => w.id));
    for (const [id, el] of windowEls) {
      if (!liveIds.has(id)) {
        el.remove();
        windowEls.delete(id);
      }
    }
    for (const w of windows) {
      if (!windowEls.has(w.id)) {
        const el = document.createElement('div');
        el.className = 'tmux-window';
        stage.append(el);
        windowEls.set(w.id, el);
      }
      const el = windowEls.get(w.id);
      el.classList.toggle('active', w.active);
      el.classList.toggle('split', list.filter((p) => p.window === w.id).length > 1);
    }

    const livePanes = new Set(list.map((p) => p.id));
    for (const [id, p] of panes) {
      if (!livePanes.has(id)) {
        p.term.dispose();
        p.el.remove();
        panes.delete(id);
      }
    }
    for (const info of list) {
      const winEl = windowEls.get(info.window);
      if (!winEl) continue;
      const pane = panes.get(info.id) ?? createPane(info, winEl);
      if (pane.el.parentElement !== winEl) winEl.append(pane.el);
      const leaf = layout.get(info.id) ?? { x: 0, y: 0 };
      Object.assign(pane.el.style, {
        left: `${leaf.x * cell.w}px`,
        top: `${leaf.y * cell.h}px`,
        width: `${info.width * cell.w}px`,
        height: `${info.height * cell.h}px`,
      });
      if (pane.term.cols !== info.width || pane.term.rows !== info.height) pane.term.resize(info.width, info.height);
    }

    for (const w of windows) renderBorders(windowEls.get(w.id), bordersFor(w, list));
    for (const w of windows) renderEnded(w, windowEls.get(w.id), list.find((p) => p.window === w.id));

    const win = windows.find((w) => w.active);
    const pane = win && list.find((p) => p.window === win.id && p.active);
    for (const info of list) panes.get(info.id)?.el.classList.toggle('active', info.active);
    // The first state after (re)connecting: tmux's window order is the one
    // the last page left, maybe in another browser; live tabs take it, dotted
    // tabs keep their places in this browser's order.
    if (!haveState) {
      const next = followTmuxOrder(tabOrder, windows);
      if (next.join() !== tabOrder.join()) {
        tabOrder = next;
        saveOrder();
      }
    }
    liveWindows = windows;
    haveState = true;
    stage.classList.remove('stale');
    renderTabs();
    // Popups of the tab left behind go with it.
    if (win && win.id !== activeWindow)
      for (const [id, el] of windowEls) if (id !== win.id) for (const pop of el.querySelectorAll('.tmux-notice, .tmux-journal')) pop.remove();
    if (pane && (pane.id !== activePane || win.id !== activeWindow)) {
      activeWindow = win.id;
      activePane = pane.id;
      panes.get(pane.id)?.term.focus();
    }
  }

  // A remote tab not connected to its machine's tmux (detached there, or
  // the connection down and Ctrl+C pressed): the machine still runs, so the
  // tab stays with a choice, as buttons (the terminal offers the same
  // as keys, which is what the buttons press).
  function renderEnded(w, winEl, pane) {
    let box = winEl.querySelector(':scope > .remote-ended');
    if (!w.remote?.ended || !pane) return box?.remove();
    const r = remoteOf(w);
    if (box?.dataset.host === w.remote.host) return;
    box?.remove();
    box = document.createElement('div');
    box.className = 'remote-ended';
    box.dataset.host = w.remote.host;
    box.style.setProperty('--remote', r.color);
    const title = document.createElement('strong');
    title.textContent = `Not connected to ${r.label} ${r.noun} ${w.remote.host}`;
    const info = document.createElement('div');
    info.textContent = `The ${r.noun} is still there (${r.lifetime}).`;
    const row = document.createElement('div');
    row.className = 'buttons';
    const button = (label, cls, run) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', run);
      row.append(b);
    };
    button('Reconnect', 'primary', () => send({ t: 'in', p: pane.id, d: '\r' }));
    button(`Delete the ${r.noun}…`, 'danger', () => {
      if (confirm(`Delete ${r.label} ${r.noun} ${w.remote.host} for good?\n\nEverything on it is lost, and this tab closes.`))
        send({ t: 'close', w: w.id });
    });
    box.append(title, info, row);
    winEl.append(box);
  }

  function createPane(info, winEl) {
    const el = document.createElement('div');
    el.className = 'tmux-pane';
    winEl.append(el);
    const term = createTerminal({ cols: info.width, rows: info.height, openExternal, keyHandler });
    leaveQueriesToTmux(term);
    term.open(el);
    term.onData((d) => send({ t: 'in', p: info.id, d }));
    term.onBinary((d) => send({ t: 'in', p: info.id, d, bin: true }));
    // Clicking a pane makes it tmux's active pane too.
    el.addEventListener(
      'mousedown',
      () => {
        if (activePane !== info.id) {
          activePane = info.id;
          send({ t: 'select-pane', p: info.id });
        }
      },
      true,
    );
    const pane = { term, el };
    panes.set(info.id, pane);
    return pane;
  }

  // The gutter between panes is ours, not tmux's. A drag there asks tmux to
  // resize; the layout notification moves the terminals, same as a key binding.
  function bordersFor(win, list) {
    const layout = new Map(parseLayout(win.layout).map((leaf) => [leaf.id, leaf]));
    const leaves = list
      .filter((p) => p.window === win.id)
      .map((p) => {
        const leaf = layout.get(p.id) ?? { x: 0, y: 0 };
        return { id: p.id, x: leaf.x, y: leaf.y, w: p.width, h: p.height };
      });
    return paneBorders(leaves);
  }

  function renderBorders(winEl, borders) {
    if (!winEl) return;
    for (const old of winEl.querySelectorAll('.tmux-resize')) old.remove();
    for (const border of borders) {
      const el = document.createElement('div');
      el.className = `tmux-resize ${border.axis}`;
      const across = border.axis === 'x' ? cell.w : cell.h;
      const along = border.axis === 'x' ? cell.h : cell.w;
      const thickness = Math.max(border.gap * across, 6);
      const at = border.at * across - (thickness - border.gap * across) / 2;
      const start = border.lo * along;
      const length = (border.hi - border.lo) * along;
      if (border.axis === 'x') {
        Object.assign(el.style, { left: `${at}px`, width: `${thickness}px`, top: `${start}px`, height: `${length}px` });
      } else {
        Object.assign(el.style, { top: `${at}px`, height: `${thickness}px`, left: `${start}px`, width: `${length}px` });
      }
      el.addEventListener('mousedown', (e) => startResize(e, border));
      winEl.append(el);
    }
  }

  function startResize(e, border) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const across = border.axis === 'x' ? cell.w : cell.h;
    const start = border.axis === 'x' ? e.clientX : e.clientY;
    let dragged = false;
    let last = null;
    const shield = document.createElement('div');
    shield.className = `tmux-resize-shield ${border.axis}`;
    const move = (ev) => {
      if (!dragged && Math.abs((border.axis === 'x' ? ev.clientX : ev.clientY) - start) < 3) return;
      if (!dragged) {
        dragged = true;
        stage.append(shield);
      }
      const rect = stage.getBoundingClientRect();
      const pos = (border.axis === 'x' ? ev.clientX - rect.left : ev.clientY - rect.top);
      const size = Math.floor(pos / across + 1e-6) - border.origin;
      if (size < 1 || size === last) return;
      last = size;
      send({ t: 'resize-pane', p: border.pane, axis: border.axis, size });
    };
    const up = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      shield.remove();
      if (!dragged) {
        activePane = border.pane;
        send({ t: 'select-pane', p: border.pane });
        panes.get(border.pane)?.term.focus();
      }
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  function loadOrder() {
    try {
      const v = JSON.parse(localStorage.getItem(ORDER_KEY));
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }
  function saveOrder() {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(tabOrder));
    } catch {}
  }
  // Another page of this browser reordered the tabs.
  window.addEventListener('storage', (e) => {
    if (e.key !== ORDER_KEY) return;
    tabOrder = loadOrder();
    renderTabs();
  });

  // Every tab, in toolbar order: { key, kind: 'live' | 'saved' | 'pending', w }.
  function currentTabs() {
    const live = new Set(liveWindows.map((w) => w.uid));
    for (const uid of pending.keys()) if (live.has(uid)) pending.delete(uid);
    const saved = new Set(savedWindows.map((w) => w.id));
    const items = [
      ...[...liveWindows].sort((a, b) => a.index - b.index).map((w) => ({ key: w.uid || w.id, kind: 'live', w })),
      ...savedWindows.filter((w) => !live.has(w.id)).map((w) => ({ key: w.id, kind: pending.has(w.id) ? 'pending' : 'saved', w })),
      ...[...pending].filter(([uid]) => !saved.has(uid)).map(([uid, w]) => ({ key: uid, kind: 'pending', w })),
    ];
    const { tabs, order } = orderTabs(tabOrder, items);
    if (order.length !== tabOrder.length) {
      tabOrder = order;
      saveOrder();
    }
    return tabs;
  }

  // Tabs are updated in place, never rebuilt, so nothing under the pointer
  // moves or loses its press when a state arrives.
  let tabItems = new Map(); // key -> current tab item
  function renderTabs() {
    if (!haveState || draggingTab) return;
    toolbar.tabs.classList.remove('offline');
    const tabs = currentTabs();
    const landed = tabs.some((t) => t.kind === 'live' && tabItems.get(t.key)?.kind === 'pending');
    tabItems = new Map(tabs.map((t) => [t.key, t]));
    for (const [key, el] of tabEls) {
      if (!tabItems.has(key)) {
        el.remove();
        tabEls.delete(key);
      }
    }
    let prev = null;
    for (const t of tabs) {
      let el = tabEls.get(t.key);
      if (!el) {
        el = tabButton(t.key);
        tabEls.set(t.key, el);
      }
      const label = t.w.name;
      if (el.textContent !== label) el.textContent = label;
      if (t.kind !== 'live') closingTabs.delete(t.key); // closed: done
      el.className =
        (t.kind === 'live'
          ? `${t.w.active ? 'active' : ''}${closingTabs.has(t.key) ? ' closing' : ''}`
          : t.kind === 'pending'
            ? 'saved pending'
            : 'saved') + (t.w.remote ? ' remote' : '');
      const tint = t.w.remote ? remoteOf(t.w).color : '';
      if (el.style.getPropertyValue('--remote') !== tint) el.style.setProperty('--remote', tint);
      const title =
        t.kind === 'live'
          ? liveTabTitle(t.w)
          : t.kind === 'pending'
            ? `${t.w.name}\n${t.w.remote ? `Joining ${remoteOf(t.w).label} ${remoteOf(t.w).noun} ${t.w.remote.host}…` : `Reopening in ${t.w.dir}…`}`
            : savedTabTitle(t.w);
      el.dataset.tip = title;
      if (tip?.el === el) showTip(el); // open: show the fresh facts
      const want = prev ? prev.nextSibling : toolbar.tabs.firstChild;
      if (want !== el) toolbar.tabs.insertBefore(el, want);
      prev = el;
    }
    // A reopened window joins tmux's list last; move it to its tab's place.
    if (landed) syncTmuxOrder();
  }

  // The tooltip of a live tab: per pane, where it is, how long it has been
  // open and what runs there, coding agents by name. Fresh facts are asked
  // for whenever the pointer comes onto the tab.
  function liveTabTitle(w) {
    const lines = [w.name];
    const info = tabInfo.get(w.id);
    if (w.remote) {
      // Up since the machine was made, not since the tab opened (making takes minutes).
      const since = info?.upSince ?? w.remote.upSince;
      const up = since ? `  ·  up ${duration(Math.max(0, Math.round(Date.now() / 1000 - since)))}` : '  ·  being made…';
      lines.push(`${remoteOf(w).label} ${remoteOf(w).noun} ${w.remote.host}${up}`, `Its shells run in the ${remoteOf(w).noun}'s own tmux.`);
    } else if (!info) lines.push('…');
    else {
      const age = (secs) => (secs == null ? null : duration(secs + Math.round((Date.now() - info.at) / 1000)));
      const several = info.panes.length > 1;
      for (const p of info.panes) {
        if (several) lines.push('');
        const open = age(p.openSecs);
        lines.push(`${several && p.active ? '▸ ' : ''}${p.dir}${open ? `  ·  open ${open}` : ''}`);
        if (p.running) {
          const ran = age(p.running.secs);
          lines.push(`${p.running.agent ?? p.running.what}${ran ? `  ·  running ${ran}` : ''}`);
        }
      }
    }
    lines.push('', 'Drag to reorder · right-click for more');
    return lines.join('\n');
  }
  function savedTabTitle(w) {
    if (w.remote)
      return [
        w.name,
        `${remoteOf(w).label} ${remoteOf(w).noun} ${w.remote.host}`,
        'Tap to join it again: its shells kept running there,',
        `unless it has been deleted since (${remoteOf(w).lifetime}).`,
        '',
        'Drag to reorder · right-click for more',
      ].join('\n');
    const lines = [w.name, `${w.dir}${w.branch ? `  ·  ${w.branch}` : ''}`];
    if (w.agent) lines.push(`Tap to resume ${w.agent.name}:`, `  ${w.agent.command}`);
    else lines.push('Saved, not running. Tap to start it again there.');
    lines.push('', 'Drag to reorder · right-click for more');
    return lines.join('\n');
  }
  function duration(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${secs}s`;
  }

  // dtmux's own tooltip under a tab: shown after a short rest of the mouse,
  // updated in place when fresher facts arrive, gone on leave or press.
  // (The browser's title tooltip shows late, never updates, and not in
  // every browser.)
  const TIP_DELAY_MS = 350;
  let tip = null; // { el, box } while shown, { el, timer } while waiting
  function armTip(el) {
    hideTip();
    tip = { el, timer: setTimeout(() => showTip(el), TIP_DELAY_MS) };
  }
  function showTip(el) {
    if (!el.isConnected || draggingTab || tabMenu) return hideTip();
    clearTimeout(tip?.timer);
    const box = tip?.box ?? document.createElement('div');
    box.className = 'tab-tip';
    const [head, ...rest] = (el.dataset.tip || '').split('\n');
    const strong = document.createElement('strong');
    strong.textContent = head;
    box.replaceChildren(strong, ...rest.map((line) => {
      const div = document.createElement('div');
      div.textContent = line || '\u00a0';
      if (/^Drag to reorder/.test(line)) div.className = 'hint';
      return div;
    }));
    if (!box.isConnected) document.body.append(box);
    tip = { el, box };
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth;
    box.style.left = `${Math.max(6, Math.min(r.left, innerWidth - w - 6))}px`;
    box.style.top = `${r.bottom + 6}px`;
  }
  function hideTip() {
    if (!tip) return;
    clearTimeout(tip.timer);
    tip.box?.remove();
    tip = null;
  }

  function tabButton(key) {
    const b = document.createElement('button');
    b.dataset.key = key;
    b.addEventListener('pointerenter', (e) => {
      const t = tabItems.get(key);
      if (t?.kind === 'live') send({ t: 'info', w: t.w.id });
      if (e.pointerType === 'mouse') armTip(b);
    });
    b.addEventListener('pointerleave', () => hideTip());
    b.addEventListener('pointerdown', (e) => {
      hideTip();
      startTabDrag(e, b);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabMenu(key, e.clientX, e.clientY);
    });
    b.addEventListener('click', () => {
      const t = tabItems.get(key);
      if (!t || !haveState) return;
      if (t.kind === 'live') {
        send({ t: 'select-window', w: t.w.id });
        panes.get(activePane)?.term.focus();
      } else if (t.kind === 'saved') {
        pending.set(key, t.w);
        setTimeout(() => {
          if (pending.delete(key)) renderTabs(); // it never came: show it as saved again
        }, 10000);
        send({ t: 'resume', id: key });
        renderTabs();
      }
    });
    return b;
  }

  // Drag a tab along the strip to move it. Pointer events, so it works with a
  // mouse, a pen or a finger. The tab follows the pointer; the others make room.
  // The tab moves in the DOM as it passes its neighbours, which drops any
  // pointer capture, so the drag listens on the window instead, and ends on
  // release, cancel or the window losing focus, wherever the pointer is then.
  function startTabDrag(e, el) {
    if (e.button !== 0 || !haveState || draggingTab) return;
    const strip = toolbar.tabs;
    const id = e.pointerId;
    const startX = e.clientX;
    const startLeft = el.offsetLeft;
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 5) return;
        moved = true;
        draggingTab = true;
        el.classList.add('dragging');
      }
      ev.preventDefault();
      ev.stopPropagation(); // the panes underneath see nothing of the drag
      const center = startLeft + dx + el.offsetWidth / 2;
      const before = [...strip.children].find((c) => c !== el && c.offsetLeft + c.offsetWidth / 2 > center) ?? null;
      if (el.nextSibling !== before && el !== before) strip.insertBefore(el, before);
      el.style.transform = `translateX(${startLeft + dx - el.offsetLeft}px)`;
    };
    const up = (ev) => {
      if (ev.pointerId === id) done();
    };
    const done = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', done);
      if (!moved) return;
      // The click that may follow is the drop, not a tap.
      const eat = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      window.addEventListener('click', eat, true);
      setTimeout(() => window.removeEventListener('click', eat, true), 0);
      el.classList.remove('dragging');
      el.style.transform = '';
      draggingTab = false;
      const keys = [...strip.children].map((c) => c.dataset.key);
      const shown = new Set(keys);
      tabOrder = [...keys, ...tabOrder.filter((k) => !shown.has(k))];
      saveOrder();
      syncTmuxOrder();
      renderTabs();
      panes.get(activePane)?.term.focus();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', done);
  }

  // Right-click on a tab. Live: Disconnect saves the window and closes it, so
  // it turns dotted in place and a tap starts it again. Dotted: Reopen, or
  // Forget it for good.
  let tabMenu = null;
  function showTabMenu(key, x, y) {
    closeTabMenu();
    const t = tabItems.get(key);
    if (!t || !haveState || t.kind === 'pending') return;
    showMenu(
      t.kind === 'live'
        ? [
            [
              'Disconnect',
              t.w.remote
                ? 'Close the ssh connection; the VM and its shells keep running, and tapping the dotted tab joins them again'
                : 'Save this window and close it; a coding agent in it is closed first and resumes when you tap the dotted tab',
              () => {
                closingTabs.add(key);
                setTimeout(() => closingTabs.delete(key) && renderTabs(), 10000);
                send({ t: 'disconnect', w: t.w.id });
                renderTabs();
              },
            ],
            t.w.remote
              ? deleteRemoteItem(t)
              : [
                  'Close',
                  'Close this window for good, ending what runs in it; no dotted tab is kept',
                  () => {
                    if (confirm(`Close "${t.w.name}" for good?\n\nThe window, and everything running in it, ends; no dotted tab is kept.`))
                      send({ t: 'close', w: t.w.id });
                  },
                ],
          ]
        : [
            [
              'Reopen',
              t.w.remote ? `Join ${t.w.remote.host} again` : `Start it again in ${t.w.dir}`,
              () => tabEls.get(key)?.click(),
            ],
            t.w.remote ? deleteRemoteItem(t) : ['Forget', 'Remove this dotted tab for good', () => send({ t: 'forget', id: key })],
          ],
      x,
      y,
    );
  }

  // A remote tab has no Close: a tab gone for good takes its machine with
  // it, so the one item says so. Asks first.
  function deleteRemoteItem(t) {
    const r = remoteOf(t.w);
    const what = `${r.label} ${r.noun} ${t.w.remote.host}`;
    return [
      `Delete the ${r.noun}…`,
      `Delete ${what}; this tab goes with it`,
      () => {
        if (confirm(`Delete ${what} for good?\n\nEverything on it is lost, and this tab goes away.`))
          send(t.kind === 'live' ? { t: 'close', w: t.w.id } : { t: 'forget', id: t.key });
      },
      '#ff6b6b',
    ];
  }

  // A small menu at (x, y): items are [label, title, action, color?].
  function showMenu(items, x, y) {
    closeTabMenu();
    hideTip();
    const menu = document.createElement('div');
    menu.className = 'tab-menu';
    menu.setAttribute('role', 'menu');
    for (const [label, title, run, color] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      if (color) b.style.color = color;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        closeTabMenu();
        run();
        panes.get(activePane)?.term.focus();
      });
      menu.append(b);
    }
    document.body.append(menu);
    // Keep it on screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    const away = (e) => {
      if (!menu.contains(e.target)) closeTabMenu();
    };
    const key_ = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTabMenu();
        panes.get(activePane)?.term.focus();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key_, true);
    window.addEventListener('blur', closeTabMenu);
    window.addEventListener('resize', closeTabMenu);
    tabMenu = {
      menu,
      off() {
        window.removeEventListener('pointerdown', away, true);
        window.removeEventListener('keydown', key_, true);
        window.removeEventListener('blur', closeTabMenu);
        window.removeEventListener('resize', closeTabMenu);
      },
    };
    menu.querySelector('button').focus();
  }
  function closeTabMenu() {
    if (!tabMenu) return;
    tabMenu.off();
    tabMenu.menu.remove();
    tabMenu = null;
  }

  // Live windows in toolbar order.
  function liveInTabOrder() {
    const pos = new Map(tabOrder.map((k, i) => [k, i]));
    const at = (w) => pos.get(w.uid || w.id) ?? Infinity;
    return [...liveWindows].sort((a, b) => at(a) - at(b) || a.index - b.index);
  }

  // Ask tmux to number its windows in toolbar order, so prefix + digit and the
  // order saved on the next restart match what the toolbar shows.
  function syncTmuxOrder() {
    const want = liveInTabOrder().map((w) => w.id);
    const now = [...liveWindows].sort((a, b) => a.index - b.index).map((w) => w.id);
    if (want.join() !== now.join()) send({ t: 'reorder', ws: want });
  }

  // Page's own tab switch. Caught before any pane, so the program there never
  // sees Ctrl+PageUp / Ctrl+PageDown.
  function switchWindow(dir) {
    const order = liveInTabOrder();
    if (order.length < 2) return;
    const i = order.findIndex((w) => w.id === activeWindow);
    const next = order[(i + dir + order.length) % order.length];
    if (!next || next.id === activeWindow) return;
    send({ t: 'select-window', w: next.id });
  }
  const eatWindowSwitch = (e) => {
    if (!windowSwitchDirection(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown' && !e.repeat) switchWindow(windowSwitchDirection(e));
  };
  window.addEventListener('keydown', eatWindowSwitch, true);
  window.addEventListener('keyup', eatWindowSwitch, true);

  // The prefix key arms tmux bindings: the next key is sent, with the prefix,
  // through tmux's key tables instead of to the pane.
  function keyHandler(e) {
    if (windowSwitchDirection(e)) return false;
    // Plain selection: Ctrl+C with text selected copies it (as Cmd+C does)
    // instead of interrupting; with nothing selected it interrupts as ever.
    const term = panes.get(activePane)?.term;
    if (plainSelect && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC' && term?.hasSelection()) {
      if (e.type === 'keydown') {
        navigator.clipboard.writeText(term.getSelection()).catch((err) => console.warn('copy failed', err));
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    if (e.type === 'keyup') return !swallowedKeyUps.delete(e.code);
    if (e.type !== 'keydown' || !prefix) return true;
    const name = tmuxKeyName(e);
    if (prefixArmed) {
      if (name === null) return false; // a bare modifier; keep waiting
      swallow(e);
      setPrefixArmed(false);
      send({ t: 'keys', keys: [prefix, name] });
      return false;
    }
    if (name === prefix) {
      swallow(e);
      setPrefixArmed(true);
      return false;
    }
    return true;
  }
  function swallow(e) {
    e.preventDefault();
    swallowedKeyUps.add(e.code);
  }
  function setPrefixArmed(on) {
    prefixArmed = on;
    toolbar.setIndicator(on ? prefix : '');
  }

  function gridSize() {
    return {
      cols: Math.max(2, Math.floor(stage.clientWidth / cell.w)),
      rows: Math.max(2, Math.floor(stage.clientHeight / cell.h)),
    };
  }
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const g = gridSize();
      if (g.cols === grid.cols && g.rows === grid.rows) return;
      grid = g;
      send({ t: 'size', cols: g.cols, rows: g.rows });
    }, 50);
  }).observe(stage);

  const newWindowButton = toolbar.addButton('+', () => send({ t: 'new-window' }), {
    side: 'left',
    title: 'New tmux window',
  });

  // Right-click on + (or a long press) offers the remotes of ~/.dtmux.yaml
  // too: a new tab on a new machine there. Paid ones (VMs) ask first.
  function setRemotes(list) {
    remotes = Array.isArray(list) ? list : [];
    newWindowButton.title = remotes.length ? 'New tmux window · right-click for a remote machine' : 'New tmux window';
    renderTabs();
  }
  function showNewMenu() {
    if (newWindowButton.disabled) return;
    const r = newWindowButton.getBoundingClientRect();
    showMenu(
      [
        ['New window', 'A new tmux window on this machine', () => send({ t: 'new-window' })],
        ...remotes.map((x) => [
          `New ${x.label} ${x.noun}${x.paid ? '…' : ''}`,
          `A new tab on a new ${x.label} ${x.noun}${x.plan ? ` (${x.plan})` : ''}, ${x.lifetime}`,
          () => newRemote(x.name),
          x.color,
        ]),
      ],
      r.left,
      r.bottom + 4,
    );
  }
  newWindowButton.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showNewMenu();
  });
  let pressTimer = null;
  newWindowButton.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      showNewMenu();
      const eat = (ev) => (ev.preventDefault(), ev.stopPropagation());
      window.addEventListener('click', eat, { capture: true, once: true });
    }, 500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
    newWindowButton.addEventListener(ev, () => clearTimeout(pressTimer));
  function newRemote(name) {
    const r = remotes.find((x) => x.name === name);
    if (!r) return;
    const ok =
      !r.paid ||
      confirm(
        `Make a new ${r.label} ${r.noun}?\n\n${r.plan ? `Plan ${r.plan}; it` : 'It'} costs money while it exists and is ${r.lifetime}.\nMaking it takes a few minutes; the new tab shows how it goes.`,
      );
    if (ok) send({ t: 'new-remote', name });
    panes.get(activePane)?.term.focus();
  }
  // The remote a tab's window is on, as configured (or a stand-in).
  const remoteOf = (w) =>
    remotes.find((r) => r.name === w.remote?.name) ?? {
      label: w.remote?.name ?? '',
      color: '#c58af9',
      noun: 'machine',
      lifetime: 'not in ~/.dtmux.yaml any more',
    };

  // Both restarts run the code on disk now. Soft: only dtmux restarts; tmux
  // and every shell keep running and the page reattaches. Full: the windows
  // are saved as dotted tabs and tmux ends with everything in it.
  function askRestart(t) {
    const asked = ws;
    send({ t });
    // A daemon older than this page (which is read fresh from disk) ignores
    // a restart it does not know.
    setTimeout(() => {
      if (ws !== asked || ws.readyState !== WebSocket.OPEN) return;
      const cmd = document.getElementById('status').dataset.startCmd || 'dtmux';
      showNotice(
        t === 'soft-restart'
          ? `This dtmux daemon is older than this page. Run in a terminal (tmux keeps running):\n${cmd} restart`
          : `This dtmux daemon is older than this page. Run in a terminal:\n${cmd} restart --full`,
        'bad',
      );
    }, 3000);
  }
  const restartButton = toolbar.addButton(
    '↻ Restart',
    () => {
      const r = restartButton.getBoundingClientRect();
      showMenu(
        [
          ['Soft restart', 'Restart dtmux only: tmux and every shell keep running', () => askRestart('soft-restart')],
          [
            'Full restart…',
            'Save the windows as dotted tabs and end tmux with every shell in it',
            () => {
              const ok = confirm(
                'Full restart of dtmux?\n\nEvery shell and program in it ends. The windows are saved and come back as dotted tabs: tap one to reopen it.',
              );
              if (ok) askRestart('restart');
            },
          ],
        ],
        r.right,
        r.bottom + 4,
      );
    },
    { title: 'Restart dtmux with the code on disk now' },
  );
  restartButton.classList.add('restart');
  restartButton.disabled = true;

  // Text selection. Smart: mouse events go to the program in the terminal
  // when it asks for them (tmux, vim, an agent's UI), so selecting is theirs.
  // Plain: the page selects text itself, instantly, for Cmd+C, whatever the
  // program wants; the wheel still goes to the program. Over a slow link (a
  // remote VM's tmux) plain is the one that feels right. Implemented as the
  // Option+drag xterm.js already offers: the press is handed on with Option.
  const SELECT_KEY = 'dtmux.plainSelect';
  let plainSelect = false;
  try {
    plainSelect = localStorage.getItem(SELECT_KEY) === '1';
  } catch {}
  const selectButton = toolbar.addButton('', () => {
    plainSelect = !plainSelect;
    try {
      localStorage.setItem(SELECT_KEY, plainSelect ? '1' : '0');
    } catch {}
    showSelectMode();
    panes.get(activePane)?.term.focus();
  });
  selectButton.classList.add('select-mode');
  document.getElementById('status').before(selectButton);
  function showSelectMode() {
    selectButton.textContent = plainSelect ? 'select: plain' : 'select: smart';
    selectButton.classList.toggle('on', plainSelect);
    selectButton.title = plainSelect
      ? 'Plain text selection: dragging selects text here, instantly, for Cmd+C; programs get no clicks. Click for smart.'
      : 'Smart selection: programs that use the mouse (tmux, vim, agents) get clicks and drags. Option+drag still selects text. Click for plain.';
  }
  showSelectMode();
  // The press, the movement and the release of a drag all go with Option,
  // or the program still gets the motion (and the selection is cut short).
  // Plain hover motion over a terminal too: programs get no mouse at all.
  let plainDrag = false;
  const overTerminal = (e) => e.target instanceof Element && e.target.closest('.tmux-pane .xterm-screen');
  const forceSelect = (e) => {
    if (!plainSelect || !e.isTrusted || e.altKey) return;
    if (e.type === 'mousedown') {
      if (e.button !== 0 || !overTerminal(e)) return;
      plainDrag = true;
    } else if (!plainDrag && !overTerminal(e)) return;
    if (e.type === 'mouseup') plainDrag = false;
    e.stopImmediatePropagation();
    e.preventDefault();
    // The press goes to the terminal (with Option, so xterm.js selects). The
    // movement and release go to the document only: the selection follows
    // them there, while the terminal element, which reports them to the
    // program, never sees them.
    const to = e.type === 'mousedown' ? e.target : document;
    to.dispatchEvent(new MouseEvent(e.type, { ...pick(e), altKey: true, bubbles: true, cancelable: true }));
    // Taking over the press keeps the terminal from taking the focus; give
    // it, so Cmd+C reaches the terminal that has the selection.
    if (e.type === 'mousedown') {
      const id = [...panes].find(([, p]) => p.el.contains(e.target))?.[0];
      panes.get(id)?.term.focus();
    }
  };
  const pick = (e) => ({
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    button: e.button,
    buttons: e.buttons,
    detail: e.detail,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    view: window,
  });
  for (const type of ['mousedown', 'mousemove', 'mouseup']) window.addEventListener(type, forceSelect, true);

  connect();
  window.tmuxPanes = panes; // for debugging from the console
  return { panes };
}

// Character cell size in CSS pixels, as xterm.js renders it.
function measureCell(parent) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;visibility:hidden;width:400px;height:200px';
  parent.append(el);
  const term = createTerminal({ cols: 10, rows: 5, openExternal() {} });
  term.open(el);
  // xterm.js has no public API for the cell size.
  const { width, height } = term._core._renderService.dimensions.css.cell;
  term.dispose();
  el.remove();
  return { w: width, h: height };
}
