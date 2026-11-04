// Pane commands in a remote tab act on the machine, not here.
//
// A remote tab is one window here whose single pane runs ssh into the
// machine's own tmux. Splitting it, moving between panes, zooming or closing
// one is meant for the machine's panes. The machine's tmux is told (in
// DEFAULT_ATTACH, remote-config.js) to read made-up key sequences as those
// commands; dtmux types the sequence into the tab instead of running the
// command here:
// - Splits, from any key or command: SPLIT_HOOK, an after-split-window hook
//   on dtmux's tmux, undoes the local split at once and types the split key.
// - The rest, from prefix keys: the page sends those through dtmux
//   (tmux-session.js), which looks up what the key is bound to here
//   (remoteAction) and, in a remote tab, types that action's key instead.
import { quote } from './tmux-control.js';

// name -> [user-keys index on the machine, tmux command there]. The key sent
// is ESC [ 99<index> ~, which nothing else sends.
const ACTIONS = {
  splitH: [40, 'split-window -h -c "#{pane_current_path}"'],
  splitV: [41, 'split-window -v -c "#{pane_current_path}"'],
  left: [42, 'select-pane -L'],
  right: [43, 'select-pane -R'],
  up: [44, 'select-pane -U'],
  down: [45, 'select-pane -D'],
  next: [46, 'select-pane -t :.+'],
  last: [47, 'last-pane'],
  zoom: [48, 'resize-pane -Z'],
  // Not the last pane: with it the machine's session, and so the machine,
  // would go. Deleting the machine is the tab menu's, which asks first.
  kill: [49, 'if -F "#{==:#{session_windows}#{window_panes},11}" "display-message \\"The last pane stays: delete the machine from the tab menu\\"" kill-pane'],
};

const sequence = (index) => `\x1b[99${index}~`;
const hex = (s) => [...Buffer.from(s, 'latin1')].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// The arguments of `send-keys` that type action `name` into a pane.
export const actionKeys = (name) => `-H ${hex(sequence(ACTIONS[name][0]))}`;

// tmux commands (for the machine's tmux command line, after
// `new-session ... \;`) that bind every action there.
export function remoteBindings(shellQuote) {
  return Object.values(ACTIONS)
    .flatMap(([i, cmd]) => [
      `set -s user-keys[${i}] "$(printf '\\033[99${i}~')"`,
      `bind -n User${i} ${shellQuote(cmd)}`,
    ])
    .join(' \\; ');
}

// Side by side when the panes are narrower than the window. `!` is the pane
// that was active before the split: the tab's own (its ssh); the new one,
// active now, goes.
export const SPLIT_HOOK = `if -F ${quote('#{@dtmux_remote}')} ${quote(
  `if -F ${quote('#{!=:#{pane_width},#{window_width}}')} ${quote(`send-keys -t ! ${actionKeys('splitH')}`)} ${quote(
    `send-keys -t ! ${actionKeys('splitV')}`,
  )} ; kill-pane`,
)}`;

// The action a prefix binding here stands for, or null: what the key does
// to panes, whatever key it is.
export function remoteAction(command) {
  const c = String(command ?? '').trim();
  if (/[;{]/.test(c.replace(/#\{[^}]*\}/g, ''))) return null; // a list or a block: not ours to guess
  let m;
  if ((m = /^select-pane(?:\s+-[a-zA-Z]+)*?\s+-([LRUD])\b/.exec(c))) return { L: 'left', R: 'right', U: 'up', D: 'down' }[m[1]];
  if (/^select-pane\s+-t\s+:?\.\+$/.test(c)) return 'next';
  if (/^last-pane\b/.test(c)) return 'last';
  if (/^resize-pane\s+-Z\s*$/.test(c)) return 'zoom';
  if (/^kill-pane\s*$/.test(c)) return 'kill';
  if (/^split-window\b/.test(c)) return /\s-h\b/.test(c) ? 'splitH' : 'splitV';
  return null;
}
