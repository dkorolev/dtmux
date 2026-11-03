// Remembers each tmux pane's kitty keyboard flags across browser reconnects.
//
// tmux does not implement the kitty keyboard protocol, so it cannot tell a new
// client that, say, Claude Code in pane %3 asked for enhanced keys. We watch
// the pane output for the protocol's push / pop / set sequences instead, and
// replay the current flags into a fresh terminal on attach. Flags are tied to
// the command that was running when they were set, so a stale entry is not
// replayed into a shell that has since replaced that program.
const panes = new Map(); // pane id -> { cur, stack, tail, cmd }
const SEQ = /\x1b\[([<>=])([0-9;]*)u/g;

export function trackKitty(paneId, data) {
  let st = panes.get(paneId);
  const text = (st?.tail ?? '') + data.toString('latin1');
  if (!st && !text.includes('\x1b[')) return false;
  st ??= { cur: 0, stack: [], tail: '', cmd: undefined };
  panes.set(paneId, st);
  let seen = false;
  for (const m of text.matchAll(SEQ)) {
    seen = true;
    const [a = '', b = ''] = m[2].split(';');
    if (m[1] === '>') {
      st.stack.push(st.cur);
      if (st.stack.length > 16) st.stack.shift();
      st.cur = Number(a) || 0;
    } else if (m[1] === '<') {
      for (let n = Number(a) || 1; n > 0; n--) st.cur = st.stack.pop() ?? 0;
    } else {
      const f = Number(a) || 0;
      const mode = Number(b) || 1;
      st.cur = mode === 1 ? f : mode === 2 ? st.cur | f : st.cur & ~f;
    }
  }
  // Keep an unfinished escape sequence at the end for the next chunk.
  const esc = text.lastIndexOf('\x1b');
  st.tail =
    esc !== -1 && text.length - esc < 32 && /^\x1b(\[[<>=]?[0-9;]*)?$/.test(text.slice(esc)) ? text.slice(esc) : '';
  // Any push / pop / set, even one that leaves the flags as they were, may
  // come from a new program: note which one is running now.
  if (seen) st.cmd = undefined;
  return seen && st.cur !== 0;
}

export function recordKittyCommand(paneId, cmd) {
  const st = panes.get(paneId);
  if (st && st.cur !== 0) st.cmd = cmd;
}

// Escape sequence that restores the pane's flags, or '' when nothing to do.
export function kittyRestoreSequence(paneId, currentCmd) {
  const st = panes.get(paneId);
  if (!st || st.cur === 0) return '';
  if (st.cmd !== undefined && st.cmd !== currentCmd) return '';
  return `\x1b[=${st.cur};1u`;
}

export function forgetPane(paneId) {
  panes.delete(paneId);
}

// Hand-over across a soft restart, when the tmux server and its panes live on
// but this process does not: every pane's flags, as plain data.
export function exportKitty() {
  return [...panes].filter(([, st]) => st.cur !== 0).map(([id, st]) => ({ id, cur: st.cur, stack: st.stack, cmd: st.cmd ?? null }));
}

export function importKitty(list) {
  if (!Array.isArray(list)) return;
  for (const e of list) {
    if (typeof e?.id !== 'string' || !/^%\d+$/.test(e.id) || !Number.isInteger(e.cur)) continue;
    const stack = Array.isArray(e.stack) ? e.stack.filter(Number.isInteger).slice(-16) : [];
    panes.set(e.id, { cur: e.cur, stack, tail: '', cmd: typeof e.cmd === 'string' ? e.cmd : undefined });
  }
}
