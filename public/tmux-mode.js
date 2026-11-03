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
import { orderTabs, parseLayout, paneBorders, tmuxKeyName, windowSwitchDirection } from './tmux-util.js';

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
  let sessionName = params.get('session') || 'dtmux';
  let activeWindow = null;
  // Toolbar tabs. Live windows, and windows saved when dtmux last stopped
  // (dotted until tapped, which reopens them). A tapped one is pending until
  // its window shows up, and keeps its place meanwhile. Tabs are keyed by the
  // window's long id, which a saved window keeps when reopened, and ordered by
  // `tabOrder`: the user's drag-and-drop order, remembered in this browser.
  let liveWindows = [];
  let savedWindows = [];
  const pending = new Map(); // long id -> saved window, tapped, not live yet
  let haveState = false; // false while (re)connecting: the old tabs stay put, dimmed
  let draggingTab = false;
  const ORDER_KEY = `dtmux.tabOrder.${params.get('session') || ''}`;
  let tabOrder = loadOrder();
  const tabEls = new Map(); // key -> button
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
      if (!ended) retryConnect(ev.reason);
    };
    ws.onerror = () => {
      if (!retry) toolbar.setStatus('error', 'bad');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.t) {
        case 'idle':
          showIdle(msg.session);
          break;
        case 'hello':
          stage.querySelector('.tmux-overlay.idle')?.remove();
          newWindowButton.disabled = false;
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
        case 'out':
          panes.get(msg.p)?.term.write(base64ToBytes(msg.d));
          break;
        case 'prompt':
          showPrompt(msg);
          break;
        case 'notice':
          showNotice(msg.text, msg.kind);
          break;
        case 'journal':
          showJournal(msg);
          break;
        case 'saved':
          savedWindows = Array.isArray(msg.windows) ? msg.windows : [];
          renderTabs();
          break;
        case 'exit':
          ended = true;
          if (msg.sessionGone) showEnded('session ended', `Session "${sessionName}" ended.`, 'Start a new session');
          else showEnded('detached', `Detached from session "${sessionName}" (${msg.reason}).`, 'Reattach');
          break;
      }
    };
  }

  // The daemon went away (restarting, stopped, crashed): drop the dead panes,
  // keep the tabs where they are, dimmed, and keep retrying on our own. Only
  // if that takes a while, say how to start the daemon again; a restart is
  // usually back before then.
  const OVERLAY_DELAY_MS = 1500;
  function retryConnect(reason) {
    if (!retry) {
      resetView();
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

  function resetView() {
    for (const pane of panes.values()) pane.term.dispose();
    panes.clear();
    for (const el of windowEls.values()) el.remove();
    windowEls.clear();
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

  const JOURNAL = {
    claude: 'Claude resume session journaled',
    codex: 'Codex resume session journaled',
    cursor: 'Cursor agent resume session journaled',
  };
  function showJournal({ agent, command, dir, branch, commit, dirty }) {
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
    stage.append(el);
    setTimeout(() => el.remove(), 15000);
  }

  function showNotice(text, kind = '') {
    if (!text) return;
    for (const old of stage.querySelectorAll('.tmux-notice')) old.remove();
    const el = document.createElement('div');
    el.className = `tmux-notice ${kind}`;
    el.textContent = text;
    el.title = 'Click to dismiss';
    el.addEventListener('click', () => el.remove());
    stage.append(el);
    setTimeout(() => el.remove(), Math.min(20000, 4000 + text.length * 40));
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

    const win = windows.find((w) => w.active);
    const pane = win && list.find((p) => p.window === win.id && p.active);
    for (const info of list) panes.get(info.id)?.el.classList.toggle('active', info.active);
    liveWindows = windows;
    haveState = true;
    renderTabs();
    if (pane && (pane.id !== activePane || win.id !== activeWindow)) {
      activeWindow = win.id;
      activePane = pane.id;
      panes.get(pane.id)?.term.focus();
    }
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
      el.className = t.kind === 'live' ? (t.w.active ? 'active' : '') : t.kind === 'pending' ? 'saved pending' : 'saved';
      el.title =
        t.kind === 'live'
          ? `tmux window ${t.w.index}: ${t.w.name}\nDrag to reorder.`
          : t.kind === 'pending'
            ? `Reopening in ${t.w.dir}…`
            : `Saved when dtmux stopped: ${t.w.dir}\nTap to reopen it there. Drag to reorder.`;
      const want = prev ? prev.nextSibling : toolbar.tabs.firstChild;
      if (want !== el) toolbar.tabs.insertBefore(el, want);
      prev = el;
    }
    // A reopened window joins tmux's list last; move it to its tab's place.
    if (landed) syncTmuxOrder();
  }

  function tabButton(key) {
    const b = document.createElement('button');
    b.dataset.key = key;
    b.addEventListener('pointerdown', (e) => startTabDrag(e, b));
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

  const restartButton = toolbar.addButton(
    '↻ Restart',
    () => {
      const ok = confirm(
        'Restart dtmux?\n\nEvery shell and program in it ends. The windows are saved and come back as dotted tabs: tap one to reopen it.',
      );
      if (!ok) return;
      const asked = ws;
      send({ t: 'restart' });
      // A daemon started before the Restart button existed ignores it, while
      // this page, read fresh from disk, already has the button.
      setTimeout(() => {
        if (ws === asked && ws.readyState === WebSocket.OPEN)
          showNotice(
            `This dtmux daemon is older than this page and cannot restart itself. Run once in a terminal:\n${document.getElementById('status').dataset.startCmd || 'dtmux'} kill && ${document.getElementById('status').dataset.startCmd || 'dtmux'}`,
            'bad',
          );
      }, 3000);
    },
    { title: 'Restart dtmux with the code on disk now; the windows are saved as dotted tabs' },
  );
  restartButton.classList.add('restart');
  restartButton.disabled = true;

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
