// Terminal setup shared by the tmux and the plain-shell modes.
import { Terminal } from '/vendor/xterm.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { macLineEdit, macWordEdit } from './tmux-util.js';

export const SCROLLBACK = 10000;

// A terminal with our defaults: kitty keyboard protocol on, so programs can
// tell Shift+Enter from Enter; links handed to `openExternal`, which opens
// them in the OS default browser; and browser-level shortcuts kept working.
// `keyHandler(e)` sees every other key event and returns false to swallow it.
export function createTerminal({ cols, rows, scrollback = SCROLLBACK, openExternal, keyHandler }) {
  const term = new Terminal({
    cols,
    rows,
    cursorBlink: true,
    fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, monospace',
    fontSize: 13,
    scrollback,
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard: true },
    // OSC 8 hyperlinks (e.g. `ls --hyperlink`).
    linkHandler: { activate: (_event, url) => openExternal(url) },
    theme: { background: '#1e1e1e' },
  });
  // Plain-text URLs.
  term.loadAddon(new WebLinksAddon((_event, url) => openExternal(url)));
  term.attachCustomKeyEventHandler((e) => browserKey(term, e) ?? (keyHandler ? keyHandler(e) : true));
  return term;
}

// Keys that belong to the browser rather than the program in the terminal.
// Returns the verdict for xterm.js, or undefined when the key is not one of them.
// - Cmd+C with a selection copies it. Otherwise a program that enabled the
//   kitty keyboard protocol would receive Cmd+C as "ESC [99;9u".
// - Cmd+V is left to the browser so its paste event reaches xterm.js.
// - Browser tab shortcuts (Cmd+T/W/N/R/L) stay with the browser.
// - Cmd+Left / Cmd+Right move to the start and end of the line.
// - Option+Left / Option+Right move by word.
function browserKey(term, e) {
  const line = macLineEdit(e) || macWordEdit(e);
  if (line) {
    if (e.type === 'keydown') {
      e.preventDefault();
      term.input(line);
    }
    return false;
  }
  if (!e.metaKey || e.altKey || e.ctrlKey) return undefined;
  const key = e.key.toLowerCase();
  if (key === 'c' && term.hasSelection()) {
    if (e.type === 'keydown') {
      navigator.clipboard.writeText(term.getSelection()).catch((err) => console.warn('copy failed', err));
    }
    return false;
  }
  if (key === 'v' || ['t', 'w', 'n', 'r', 'l'].includes(key)) return false;
  return undefined;
}

// Behind tmux, programs' terminal queries reach both tmux and this terminal.
// tmux answers these itself, so a second answer from xterm.js would arrive as
// stray input. The kitty keyboard query (CSI ? u) is not among them: tmux does
// not implement the protocol, so xterm.js must answer that one.
export function leaveQueriesToTmux(term) {
  const swallow = () => true;
  const csi = [
    { final: 'c' }, // primary device attributes
    { prefix: '>', final: 'c' }, // secondary device attributes
    { prefix: '=', final: 'c' }, // tertiary device attributes
    { final: 'n' }, // device status / cursor position report
    { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' }, // mode queries (DECRQM)
    { prefix: '?', intermediates: '$', final: 'p' },
    { prefix: '>', final: 'q' }, // terminal name and version (XTVERSION)
  ];
  for (const id of csi) term.parser.registerCsiHandler(id, swallow);
  // Color queries ("?") only; color changes still apply.
  for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, (data) => data.split(';').includes('?'));
}

export function base64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function socketUrl(query) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?${new URLSearchParams(query)}`;
}
