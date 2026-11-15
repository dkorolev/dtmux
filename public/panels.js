// Two panels over the page:
//
// - gh on a remote tab's machine: a small box drawn in text. It shows who
//   gh is logged in as on this Mac, whether that token passes a check in a
//   clean container (and that container's image being built, when it is),
//   and who gh is on the machine; Instrument gh logs the machine in with
//   the token, Un-instrument gh logs it out (server/gh-remote.js).
// - Settings: the check container (runtime, image, Rebuild) and the
//   connectors, the `remotes:` of ~/.dtmux.yaml, edited field by field and
//   saved back with the file's comments kept (server/settings.js).
//
// makePanels({ send, focus }) -> { showGh(tab), showSettings(), onMessage(msg) }.
// onMessage takes the server's 'gh', 'container', 'settings' and
// 'settings-saved' messages and returns true when it took one.

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const W = 62; // the gh box's inner width, in characters

export function makePanels({ send, focus }) {
  let container = null; // the latest container status from the server
  let gh = null; // the open gh panel: { w, title, host, check, machine, busy, done, el, timer }
  let settings = null; // the open Settings panel: { el, data, ... }

  // --- shared -------------------------------------------------------------

  function overlay(cls, onClose) {
    const shade = document.createElement('div');
    shade.className = `panel-shade ${cls}`;
    shade.addEventListener('mousedown', (e) => e.target === shade && onClose());
    shade.addEventListener('keydown', (e) => {
      e.stopPropagation(); // not for the terminal or the page's own keys
      if (e.key === 'Escape') onClose();
    });
    document.body.append(shade);
    return shade;
  }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // A chamfered action. The label is a span so it paints above the edge.
  const chamferButton = (cls, text) => {
    const b = el('button', cls ? `act ${cls}` : 'act');
    b.append(el('span', '', text));
    return b;
  };
  // The field's edge is this shell, not a border on the control. A border
  // clipped to a chamfer loses its corner strokes.
  const fieldShell = (control) => {
    const shell = el('div', 'field');
    shell.append(control);
    return shell;
  };
  const containerLine = (c) => {
    if (!c) return 'looking for a container runtime…';
    if (c.state === 'building') return `building the check image with ${c.runtime}…`;
    if (c.state === 'ready') return `check image ready (${c.runtime})`;
    if (c.state === 'missing') return `no check image yet (${c.runtime}); built on first use`;
    if (c.state === 'no-runtime') return c.error;
    if (c.state === 'failed') return c.error;
    return 'looking for a container runtime…';
  };

  // --- gh -----------------------------------------------------------------

  function showGh(t) {
    closeGh();
    const r = t.remoteInfo;
    gh = {
      w: t.w.id,
      title: `gh · ${r.label} ${r.noun} ${t.w.remote.host}`,
      host: null,
      check: null,
      machine: null,
      busy: null,
      done: null,
      frame: 0,
    };
    gh.shade = overlay('gh-shade', closeGh);
    gh.el = el('div', 'gh-box');
    gh.el.setAttribute('role', 'dialog');
    gh.el.setAttribute('aria-label', gh.title);
    gh.el.tabIndex = -1;
    gh.shade.append(gh.el);
    gh.timer = setInterval(() => {
      gh.frame++;
      renderGh();
    }, 100);
    send({ t: 'gh-status', w: gh.w });
    renderGh();
    setTimeout(() => gh?.el.focus()); // after a menu hands focus back to the terminal
  }
  function closeGh() {
    if (!gh) return;
    clearInterval(gh.timer);
    gh.shade.remove();
    gh = null;
    focus();
  }

  const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const spin = () => SPIN[gh.frame % SPIN.length];

  function renderGh() {
    if (!gh) return;
    const rows = []; // each: array of strings and { button, run, disabled }
    const text = (s) => rows.push([fit(s, W)]);
    const field = (name, value) => text(`${name.padEnd(13)}${value}`);
    const scopes = (x) => (x?.scopes?.length ? `  (${x.scopes.join(', ')})` : '');
    text('');
    const h = gh.host;
    field('this Mac', !h ? `${spin()} gh auth status…` : h.ok ? `✓ ${h.login}${scopes(h)}` : `✗ ${h.error}`);
    const c = gh.check;
    if (!c) {
      field('clean check', `${spin()} ${containerLine(container)}`);
      if (container?.state === 'building') field('', `  ${container.log?.at(-1) ?? ''}`);
    } else field('clean check', c.ok ? `✓ the token works as ${c.login}` : `✗ ${c.error}`);
    const m = gh.machine;
    field(
      'machine',
      !m
        ? `${spin()} gh auth status there…`
        : !m.ok
          ? `✗ ${m.error}`
          : !m.gh
            ? '· gh is not installed (Instrument installs it)'
            : m.logins.length
              ? `✓ logged in as ${m.logins.join(', ')}`
              : '· gh is not logged in',
    );
    text('');
    if (gh.busy) text(`${spin()} ${gh.busy === 'gh-instrument' ? 'instrumenting' : 'un-instrumenting'}…`);
    else if (gh.done) {
      const d = gh.done;
      text(
        d.ok
          ? d.action === 'gh-instrument'
            ? `✓ gh is logged in as ${d.login} there, and git uses it`
            : '✓ gh is logged out there, and git no longer uses it'
          : `✗ ${d.error}`,
      );
    } else if (gh.error) text(`✗ ${gh.error}`);
    else text('Instrument copies this Mac\'s token to the machine.');
    text('');
    const canIn = !gh.busy && h?.ok && c?.ok && m?.ok;
    const canOut = !gh.busy && m?.ok && m.gh && m.logins.length;
    rows.push([
      { button: 'Instrument gh', disabled: !canIn, run: () => act('gh-instrument') },
      '  ',
      { button: 'Un-instrument gh', disabled: !canOut, run: () => act('gh-uninstrument') },
      '  ',
      { button: 'Close', run: closeGh },
    ]);

    // Draw it: ┌─ title ─┐, │ rows │, └──┘. Buttons are real buttons, the
    // same elements from one drawing to the next (a click that starts on one
    // must end on it), and nothing is redrawn while nothing changed.
    const key = JSON.stringify(rows.map((row) => row.map((p) => (typeof p === 'string' ? p : [p.button, Boolean(p.disabled)]))));
    if (key === gh.drawn) return;
    gh.drawn = key;
    gh.buttons ??= new Map();
    gh.el.replaceChildren();
    const line = (...parts) => {
      const l = el('div', 'gh-line');
      for (const p of parts) l.append(typeof p === 'string' ? document.createTextNode(p) : p);
      gh.el.append(l);
    };
    const title = ` ${fit(gh.title, W - 2).trimEnd()} `;
    line(`┌─${title}${'─'.repeat(Math.max(0, W - title.length))}─┐`);
    for (const row of rows) {
      const parts = [];
      let len = 0;
      for (const p of row) {
        if (typeof p === 'string') {
          parts.push(p);
          len += p.length;
        } else {
          let b = gh.buttons.get(p.button);
          if (!b) {
            b = el('button', 'gh-button', `[ ${p.button} ]`);
            b.addEventListener('click', () => b.run?.());
            gh.buttons.set(p.button, b);
          }
          b.run = p.run;
          b.disabled = Boolean(p.disabled);
          parts.push(b);
          len += p.button.length + 4;
        }
      }
      line('│ ', ...parts, ' '.repeat(Math.max(0, W - len)), ' │');
    }
    line(`└${'─'.repeat(W + 2)}┘`);
  }

  function act(action) {
    if (!gh) return;
    gh.done = null;
    gh.busy = action;
    send({ t: action, w: gh.w });
    renderGh();
  }

  function onGh(msg) {
    if (!gh || msg.w !== gh.w) return;
    if (msg.part === 'host') gh.host = msg;
    else if (msg.part === 'check') gh.check = msg;
    else if (msg.part === 'machine') gh.machine = msg;
    else if (msg.part === 'busy') gh.busy = msg.action;
    else if (msg.part === 'done') {
      gh.busy = null;
      gh.done = msg;
    } else if (msg.part === 'error') {
      gh.busy = null;
      gh.error = msg.error;
      gh.host ??= { ok: false, error: '-' };
      gh.check ??= { ok: false, error: '-' };
      gh.machine ??= { ok: false, error: msg.error };
    }
    renderGh();
  }

  // --- Settings -----------------------------------------------------------

  function showSettings() {
    closeSettings();
    settings = { data: null, edited: null, added: new Set(), note: null };
    settings.shade = overlay('settings-shade', closeSettings);
    settings.el = el('div', 'settings');
    settings.el.setAttribute('role', 'dialog');
    settings.el.setAttribute('aria-label', 'dtmux settings');
    settings.shade.append(settings.el);
    settings.el.tabIndex = -1;
    send({ t: 'settings-get' });
    renderSettings();
    setTimeout(() => settings?.el.focus());
  }
  function closeSettings() {
    if (!settings) return;
    settings.shade.remove();
    settings = null;
    focus();
  }

  // A runtime's failure, one short phrase. The page may still be talking to a
  // daemon that sent the old long socket error.
  function shortWhy(why) {
    if (!why) return 'unavailable';
    if (why === 'not installed' || why === 'not running') return why;
    if (/unable to connect|cannot connect|connection refused|no such file|socket|not running|machine/i.test(why)) return 'not running';
    const sentence = why.split(/[.:\n]/)[0].trim();
    return sentence.length > 48 ? `${sentence.slice(0, 45)}…` : sentence;
  }

  function renderGhSection(box) {
    box.replaceChildren();
    const c = container;
    box.append(el('h3', '', 'gh'));
    box.append(el('p', 'muted', "Before a remote tab's gh is given this Mac's token, the token is checked in a clean container."));
    const state = el('p', `state ${c?.state ?? ''}`, `${c?.state === 'building' ? SPIN[Math.floor(Date.now() / 100) % SPIN.length] + ' ' : ''}${containerLine(c)}`);
    box.append(state);
    if (c?.log?.length && (c.state === 'building' || c.state === 'failed' || settings.showLog)) {
      const pre = el('pre', 'build-log', c.log.slice(-14).join('\n'));
      box.append(pre);
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    }
    const row = el('div', 'row');
    const rebuild = chamferButton('', c?.state === 'building' ? 'Building…' : 'Rebuild');
    rebuild.disabled = c?.state === 'building' || c?.state === 'no-runtime';
    rebuild.addEventListener('click', () => {
      settings.showLog = true;
      send({ t: 'container-rebuild' });
    });
    row.append(rebuild);
    if (c?.log?.length && c.state !== 'building') {
      const log = chamferButton('', settings.showLog ? 'Hide log' : 'Show log');
      log.addEventListener('click', () => {
        settings.showLog = !settings.showLog;
        renderSettings();
      });
      row.append(log);
    }
    box.append(row);
  }

  function renderRuntimes(box) {
    box.replaceChildren();
    const c = container;
    box.append(el('h3', '', 'Containers'));
    box.append(el('p', 'muted', 'The first one that is running does that check.'));
    const list = el('ul', 'runtimes');
    for (const r of c?.runtimes ?? []) {
      const li = el('li', r.ok ? 'ok' : 'quiet');
      li.append(el('span', 'name', r.label), el('span', 'why', r.ok ? (r.label === c.runtime ? 'in use' : 'running') : shortWhy(r.why)));
      list.append(li);
    }
    if (!c?.runtimes?.length) list.append(el('li', 'quiet', 'looking…'));
    box.append(list);
  }

  // A field's value as typed -> its YAML value ('' = the default).
  function parseField(spec, raw) {
    if (spec.type === 'bool') return raw === '' ? '' : raw === 'true';
    if (spec.type === 'int') return raw.trim() === '' ? '' : Number(raw);
    if (spec.type === 'words') return raw.trim() === '' ? '' : raw.trim().split(/\s+/);
    return raw.trim();
  }
  const showValue = (spec, v) => (v === undefined || v === null ? '' : spec.type === 'words' && Array.isArray(v) ? v.join(' ') : String(v));

  function renderConnectors(box) {
    box.replaceChildren();
    box.append(el('h3', '', 'Connectors'));
    const d = settings.data?.connectors;
    if (!d) return box.append(el('p', 'muted', 'loading…'));
    if (d.error) return box.append(el('p', 'bad', d.error));
    box.append(el('p', 'muted', `Where remote tabs live: the remotes: of ${d.path}. An empty field takes the default (shown faded). Saved into the file, its comments kept.`));
    if (d.problems?.length && !settings.edited) box.append(el('pre', 'problems', `The file has problems now:\n${d.problems.join('\n')}`));
    settings.edited ??= structuredClone(d.remotes ?? {});
    for (const [name, fields] of Object.entries(settings.edited)) {
      const specs = d.specs[fields.kind] ?? [];
      const card = el('div', 'connector');
      card.style.setProperty('--remote', fields.color || specs.find((s) => s.field === 'color')?.default || '#888');
      const head = el('div', 'head');
      head.append(el('strong', '', name), el('span', 'muted', ` ${fields.kind}`));
      const remove = el('button', 'link', 'Remove');
      remove.addEventListener('click', () => {
        if (!confirm(`Remove the connector "${name}" from ${d.path}?\n\nIts tabs stay, but dtmux cannot reach or delete their machines until a connector of that name is back.`)) return;
        delete settings.edited[name];
        renderSettings();
      });
      head.append(remove);
      card.append(head);
      const grid = el('div', 'fields');
      for (const spec of specs) {
        if (spec.field === 'kind') continue;
        const label = el('label', '', `${spec.field}${spec.required ? ' *' : ''}`);
        const value = showValue(spec, fields[spec.field]);
        const placeholder = spec.default === null || spec.default === undefined ? (spec.required ? 'required' : spec.field === 'attach' ? 'dtmux’s default' : 'none') : showValue(spec, spec.default);
        let input;
        if (spec.type === 'bool') {
          input = el('select');
          for (const [v, t] of [['', `default (${placeholder})`], ['true', 'true'], ['false', 'false']]) {
            const o = el('option', '', t);
            o.value = v;
            input.append(o);
          }
          input.value = value;
        } else {
          input = el('input');
          input.type = spec.type === 'int' ? 'number' : 'text';
          input.value = value;
          input.placeholder = placeholder;
          input.spellcheck = false;
        }
        const set = () => {
          const v = parseField(spec, input.value);
          if (v === '') delete fields[spec.field];
          else fields[spec.field] = v;
          if (spec.type === 'color') card.style.setProperty('--remote', fields.color || spec.default || '#888');
        };
        input.addEventListener('input', set);
        input.addEventListener('change', set);
        const cell = el('div', 'value');
        cell.append(fieldShell(input));
        if (spec.type === 'color') {
          const pick = el('input');
          pick.type = 'color';
          pick.value = /^#[0-9a-f]{6}$/i.test(value) ? value : spec.default || '#888888';
          pick.addEventListener('input', () => {
            input.value = pick.value;
            set();
          });
          input.addEventListener('input', () => /^#[0-9a-f]{6}$/i.test(input.value) && (pick.value = input.value));
          cell.prepend(pick);
        }
        grid.append(label, cell);
      }
      card.append(grid);
      box.append(card);
    }
    // Add one: a name and a kind; its required fields then wait to be filled.
    const add = el('div', 'add');
    const nameIn = el('input');
    nameIn.placeholder = 'new connector name, e.g. hetzner2';
    nameIn.spellcheck = false;
    const kindIn = el('select');
    for (const k of Object.keys(d.specs)) {
      const o = el('option', '', k);
      o.value = k;
      kindIn.append(o);
    }
    const addBtn = chamferButton('', 'Add');
    addBtn.addEventListener('click', () => {
      const name = nameIn.value.trim();
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return (settings.note = { bad: true, text: 'A name is lowercase letters, digits and dashes, starting with a letter.' }), renderSettings();
      if (settings.edited[name]) return (settings.note = { bad: true, text: `There is already a connector "${name}".` }), renderSettings();
      settings.edited[name] = { kind: kindIn.value };
      settings.note = null;
      renderSettings();
    });
    add.append(fieldShell(nameIn), fieldShell(kindIn), addBtn);
    box.append(add);
  }

  function renderSettings() {
    if (!settings) return;
    const keep = settings.el.querySelector('.body')?.scrollTop ?? 0;
    const active = document.activeElement;
    // Re-render only what changes on its own (the container) while a field
    // is being typed in.
    if (settings.el.childElementCount && active && settings.el.contains(active) && active.matches('input, select')) {
      const ghBox = settings.el.querySelector('.gh-sec');
      const runBox = settings.el.querySelector('.runtimes-box');
      if (ghBox) renderGhSection(ghBox);
      if (runBox) renderRuntimes(runBox);
      return;
    }
    settings.el.replaceChildren();
    const head = el('div', 'top');
    head.append(el('h2', '', 'Settings'));
    const x = chamferButton('', 'Close');
    x.addEventListener('click', closeSettings);
    head.append(x);
    const body = el('div', 'body');
    const ghBox = el('section', 'gh-sec');
    const runBox = el('section', 'runtimes-box');
    const rbox = el('section', 'connectors-box');
    renderGhSection(ghBox);
    renderRuntimes(runBox);
    renderConnectors(rbox);
    body.append(ghBox, runBox, rbox);
    const foot = el('div', 'foot');
    if (settings.note) foot.append(el('pre', settings.note.bad ? 'bad' : 'ok', settings.note.text));
    const save = chamferButton('primary', 'Save');
    save.disabled = !settings.data?.connectors || Boolean(settings.data.connectors.error);
    save.addEventListener('click', () => {
      settings.note = { text: 'saving…' };
      send({ t: 'settings-save', remotes: settings.edited });
      renderSettings();
    });
    foot.append(save);
    settings.el.append(head, body, foot);
    body.scrollTop = keep;
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'gh':
        onGh(msg);
        return true;
      case 'container':
        container = msg.status;
        renderGh();
        if (settings) renderSettings();
        return true;
      case 'settings':
        container = msg.container ?? container;
        if (settings) {
          settings.data = msg;
          settings.edited = null;
          renderSettings();
        }
        return true;
      case 'settings-saved':
        if (settings) {
          settings.note = msg.ok ? { text: 'Saved.' } : { bad: true, text: `Not saved:\n${(msg.problems ?? []).join('\n')}` };
          renderSettings();
        }
        return true;
    }
    return false;
  }

  return { showGh, showSettings, onMessage };
}
