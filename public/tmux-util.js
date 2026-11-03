// Pure helpers for tmux mode, kept free of browser imports so Node tests can load them.

// Pane rectangles from a tmux layout string, in cells, keyed by pane id.
// Example: "419a,80x24,0,0[80x12,0,0,1,80x11,0,13,2]" (a top/bottom split).
export function parseLayout(layout) {
  const s = layout.slice(layout.indexOf(',') + 1); // drop the checksum
  const leaves = [];
  let i = 0;
  const num = () => {
    const start = i;
    while (s[i] >= '0' && s[i] <= '9') i++;
    return Number(s.slice(start, i));
  };
  const cellAt = () => {
    const w = num();
    i++; // x
    const h = num();
    i++; // ,
    const x = num();
    i++; // ,
    const y = num();
    if (s[i] === ',') {
      i++;
      leaves.push({ id: `%${num()}`, x, y, w, h });
    } else if (s[i] === '{' || s[i] === '[') {
      i++;
      for (;;) {
        cellAt();
        if (s[i++] !== ',') break; // consumes the closing bracket
      }
    }
  };
  cellAt();
  return leaves;
}

// Dividers the pointer can drag. Each one is the edge of `pane`: `axis` 'x'
// is a vertical line (dragging changes that pane's width), 'y' a horizontal
// line. `at` is the cell where the border starts, `lo`/`hi` its span on the
// other axis. A one-cell hole is joined so a split line stays one drag.
export function paneBorders(leaves) {
  const raw = [];
  const overlap = (a, aLen, b, bLen) => Math.min(a + aLen, b + bLen) - Math.max(a, b);
  for (const a of leaves) {
    for (const b of leaves) {
      if (a === b) continue;
      if (a.x + a.w <= b.x) push(raw, 'x', a, b, b.x - (a.x + a.w), overlap(a.y, a.h, b.y, b.h));
      if (a.y + a.h <= b.y) push(raw, 'y', a, b, b.y - (a.y + a.h), overlap(a.x, a.w, b.x, b.w));
    }
  }
  const groups = new Map();
  for (const edge of raw) {
    const key = `${edge.axis}:${edge.at}:${edge.gap}:${edge.origin}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const borders = [];
  for (const items of groups.values()) {
    items.sort((p, q) => p.lo - q.lo);
    for (const edge of items) {
      const prev = borders.length && borders[borders.length - 1];
      const same =
        prev &&
        prev.axis === edge.axis &&
        prev.at === edge.at &&
        prev.gap === edge.gap &&
        prev.origin === edge.origin &&
        edge.lo <= prev.hi + 1;
      if (same) prev.hi = Math.max(prev.hi, edge.hi);
      else borders.push(edge);
    }
  }
  return borders.sort((p, q) => p.axis.localeCompare(q.axis) || p.at - q.at || p.lo - q.lo);
}

function push(raw, axis, a, b, gap, span) {
  if (gap < 0 || gap > 1 || span <= 0) return;
  const along0 = axis === 'x' ? a.y : a.x;
  const alongB = axis === 'x' ? b.y : b.x;
  raw.push({
    axis,
    at: axis === 'x' ? a.x + a.w : a.y + a.h,
    gap,
    pane: a.id,
    origin: axis === 'x' ? a.x : a.y,
    lo: Math.max(along0, alongB),
    hi: Math.max(along0, alongB) + span,
  });
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
const NAMED_KEYS = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BSpace',
  Delete: 'DC',
  Insert: 'IC',
  Home: 'Home',
  End: 'End',
  PageUp: 'PPage',
  PageDown: 'NPage',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
};

// Option+Left / Option+Right. xterm.js sends Alt+arrow (ESC [1;3D / ESC [1;3C).
// The Cursor agent treats that as a word move; bash and zsh do not. They do
// treat ESC b / ESC f as backward-word and forward-word.
export function macWordEdit(e) {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') return '\x1bb';
  if (e.key === 'ArrowRight' || e.code === 'ArrowRight') return '\x1bf';
  return null;
}

// Cmd+Left / Cmd+Right. xterm.js ignores these so the browser can go back and
// forward, which leaves them dead in the terminal. Terminal.app sends
// beginning-of-line and end-of-line (Ctrl+A, Ctrl+E).
export function macLineEdit(e) {
  if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') return '\x01';
  if (e.key === 'ArrowRight' || e.code === 'ArrowRight') return '\x05';
  return null;
}

// Ctrl+PageUp / Ctrl+PageDown move between the page's tmux tabs. -1 is the
// previous tab, 1 the next, 0 when this key is not that shortcut.
export function windowSwitchDirection(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return 0;
  if (e.key === 'PageDown' || e.code === 'PageDown') return 1;
  if (e.key === 'PageUp' || e.code === 'PageUp') return -1;
  return 0;
}

// tmux's name for a key event ("c", "|", "C-a", "M-Up"), or null for a bare modifier.
export function tmuxKeyName(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let base;
  let named = false;
  if (e.key === 'Tab' && e.shiftKey) base = 'BTab';
  else if (NAMED_KEYS[e.key]) {
    base = NAMED_KEYS[e.key];
    named = true;
  } else if (/^F\d{1,2}$/.test(e.key)) {
    base = e.key;
    named = true;
  } else if (e.altKey && /^Key[A-Z]$/.test(e.code)) {
    // Option on macOS turns letters into symbols; use the physical key.
    base = e.shiftKey ? e.code.slice(3) : e.code.slice(3).toLowerCase();
  } else if (e.key.length === 1) {
    base = e.ctrlKey ? e.key.toLowerCase() : e.key;
  } else {
    return null;
  }
  let name = base;
  if (named && e.shiftKey) name = `S-${name}`;
  if (e.altKey) name = `M-${name}`;
  if (e.ctrlKey) name = `C-${name}`;
  return name;
}

// The toolbar's tab order. `items` are the tabs to show ({ key, ... }), in
// their natural order (live windows by index, then saved ones). Keys `order`
// knows keep their place in it; new keys go last. Keys not shown now stay in
// the returned order, so a window that comes back (reopened, or saved again
// by a restart) lands where it was. The order keeps at most `cap` keys.
export function orderTabs(order, items, cap = 500) {
  const pos = new Map(order.map((k, i) => [k, i]));
  const known = items.filter((it) => pos.has(it.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key));
  const fresh = items.filter((it) => !pos.has(it.key));
  let next = [...order, ...fresh.map((it) => it.key)];
  if (next.length > cap) {
    const shown = new Set(items.map((it) => it.key));
    const spare = next.length - cap;
    let dropped = 0;
    next = next.filter((k) => shown.has(k) || ++dropped > spare);
  }
  return { tabs: [...known, ...fresh], order: next };
}
