// The `remotes:` part of ~/.dtmux.yaml: machines a tab can live on instead
// of this one. Each remote is reached with plain `ssh`; how its machines are
// made and found is spelled out here, never assumed by the code (see
// remote-kinds.js for what each kind does with it).
//
//   remotes:
//     lunanode:                      # the name tabs remember; [a-z0-9-]
//       kind: lunanode-ctl           # VMs made by a lunanode-ctl controller
//       controller: [ssh, lunanode, lunanode-ctl]   # how to run the controller
//       seed: ~/.ssh/lunanode.seed   # caller seed, fed on stdin, never in argv
//       plan: m.1s                   # optional; lunanode-ctl create --plan
//       image: Ubuntu 24.04          # optional; --image
//       ipv4: false                  # optional; --ipv4 (a public IPv4 too; IPv6 only otherwise)
//       ttlSeconds: 86400            # optional; the VM is deleted after this
//       hostPrefix: dtmux            # optional; new VMs are <hostPrefix>-<8 hex>
//       user: ubuntu                 # optional; ssh login on the VM
//     hetzner:
//       kind: devbox-ctl             # accounts on a host, made by devbox-ctl
//       controller: [ssh, devbox, devbox-ctl]
//       address: your.hetzner.dns.name        # where to ssh into an account directly
//   and for every kind, optional:
//       label: LunaNode              # shown on the page (default: the name)
//       color: "#c58af9"             # the tint of its tabs (default per kind)
//       identity: ~/.ssh/id_ed25519  # ssh -i
//       jump: lunanode               # ssh through this host (e.g. to reach IPv6)
//       attach: <remote command>     # what ssh runs there (see DEFAULT_ATTACH)
import os from 'node:os';
import { kindOf } from './remote-kinds.js';
import { remoteBindings } from './remote-keys.js';
import { shellQuote } from './agent-resume.js';
import path from 'node:path';

// What runs on the VM: its own tmux, so the shells there keep running with
// the connection gone (a laptop asleep or rebooting, dtmux restarted) and
// dtmux joins them again later. Always tmux: it is installed when missing.
// Its status line is off (the page has tabs) and the mouse on (the wheel
// scrolls its history). Made-up keys there split, select, zoom and close
// its panes (remote-keys.js), so those act on the machine's panes.
// Extended keys: Shift+Enter (sent enhanced by the page) reaches the
// program as Shift+Enter (ESC [13;2u), not Enter: a new line in Claude Code.
// tmux reads enhanced keys only from a terminal it knows has them, which it
// decides as the client attaches, so that comes before new-session. Set on
// every attach, so a tab gets them when it next connects.
//
// Ctrl+D in the last shell deletes the machine, a killed tmux or shell does
// not, and the two look the same from here (ssh exits 0 either way). So a
// pane that ends is kept for a moment (remain-on-exit), and when it is the
// last one and its program exited by itself (no signal: Ctrl+D, `exit`),
// ENDED_MARKER gets the time before the pane closes. Killed (out of memory,
// kill-server, kill-session, a signal), there is no marker. Cleared on
// every attach, so only a fresh one counts.
export const ENDED_MARKER = '~/.dtmux-ended';
const LAST_PANE_EXITED = '#{&&:#{==:#{pane_dead_signal},},#{==:#{server_sessions}#{session_windows}#{window_panes},111}}';
const ON_PANE_DIED = `if -F "${LAST_PANE_EXITED}" "run-shell \\"date +%s > ${ENDED_MARKER}\\"" ; kill-pane`;
export const DEFAULT_ATTACH =
  'command -v tmux >/dev/null || { echo "Installing tmux..."; sudo -n apt-get install -y -qq tmux >/dev/null; }; ' +
  `rm -f ${ENDED_MARKER}; ` +
  "exec tmux start-server \\; set -s extended-keys always \\; set -s terminal-features[90] '*:extkeys' \\; " +
  'new-session -A -s dtmux \\; set -g status off \\; set -g mouse on \\; ' +
  `set -g remain-on-exit on \\; set-hook -g pane-died ${shellQuote(ON_PANE_DIED)} \\; ` +
  remoteBindings(shellQuote);

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'must be a color like "#c58af9"');

// field -> [check(value) -> error | null, default (undefined: required)]
const COMMON = {
  kind: [(v) => (KIND_FIELDS[v] ? null : `must be one of: ${Object.keys(KIND_FIELDS).join(', ')}`), undefined],
  controller: [
    (v) => (Array.isArray(v) && v.length && v.every(isStr) ? null : 'must be a non-empty list of words, e.g. [ssh, lunanode, lunanode-ctl]'),
    undefined,
  ],
  label: [(v) => (isStr(v) && v.length <= 40 ? null : 'must be a short name'), null],
  identity: [(v) => (isStr(v) ? null : 'must be the path of an ssh private key'), null],
  jump: [(v) => (typeof v === 'string' && /^[\w@.:,\[\]-]+$/.test(v) ? null : 'must be an ssh destination, e.g. lunanode'), null],
  attach: [(v) => (isStr(v) ? null : 'must be a shell command'), DEFAULT_ATTACH],
};
const KIND_FIELDS = {
  'lunanode-ctl': {
    color: [color, '#c58af9'], // purple
    seed: [(v) => (isStr(v) ? null : 'must be the path of the caller seed file'), undefined],
    plan: [(v) => (isStr(v) ? null : 'must be a plan name, e.g. m.1s'), 'm.1s'],
    image: [(v) => (isStr(v) ? null : 'must be an image name, e.g. Ubuntu 24.04'), 'Ubuntu 24.04'],
    ipv4: [(v) => (typeof v === 'boolean' ? null : 'must be true or false'), false],
    ttlSeconds: [
      (v) => (Number.isInteger(v) && v >= 60 && v <= 2592000 ? null : 'must be an integer from 60 to 2592000'),
      86400,
    ],
    hostPrefix: [(v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(v) ? null : 'must be lowercase letters, digits and dashes'), 'dtmux'],
    user: [(v) => (typeof v === 'string' && /^[a-z_][a-z0-9_.-]*$/i.test(v) ? null : 'must be a login name'), 'ubuntu'],
  },
  'devbox-ctl': {
    color: [color, '#ff9f43'], // orange
    address: [(v) => (typeof v === 'string' && /^[\w.:-]+$/.test(v) ? null : 'must be a host name or address, e.g. your.hetzner.dns.name'), undefined],
  },
};
const fieldsOf = (kind) => ({ ...COMMON, ...(KIND_FIELDS[kind] ?? {}) });

// For the Settings page: per kind, its fields in order with
// { field, type, required, default }. type: 'kind' | 'color' | 'words' |
// 'bool' | 'int' | 'text'.
export function fieldSpecs() {
  const typeOf = (field, def) =>
    field === 'kind' ? 'kind' : field === 'color' ? 'color' : field === 'controller' ? 'words' : typeof def === 'boolean' ? 'bool' : Number.isInteger(def) ? 'int' : 'text';
  return Object.fromEntries(
    Object.keys(KIND_FIELDS).map((kind) => [
      kind,
      Object.entries(fieldsOf(kind)).map(([field, [, def]]) => ({
        field,
        type: typeOf(field, def),
        required: def === undefined,
        default: def === undefined || field === 'attach' ? null : def,
      })),
    ]),
  );
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every problem, as "name.field: ..." strings, or null.
export function checkRemotes(value) {
  if (!isMap(value)) return 'must be a mapping of remote names to their settings';
  const problems = [];
  for (const [name, r] of Object.entries(value)) {
    if (!NAME.test(name)) problems.push(`${name}: the name must be lowercase letters, digits and dashes`);
    if (!isMap(r)) {
      problems.push(`${name}: must be a mapping of settings (kind, controller, seed, ...)`);
      continue;
    }
    const FIELDS = fieldsOf(r.kind);
    for (const [field, v] of Object.entries(r)) {
      const spec = FIELDS[field];
      if (!spec) problems.push(`${name}: unknown key "${field}" (allowed for ${r.kind ?? 'this kind'}: ${Object.keys(FIELDS).join(', ')})`);
      else {
        const err = spec[0](v);
        if (err) problems.push(`${name}.${field}: ${err}, got ${show(v)}`);
      }
    }
    for (const [field, [, def]] of Object.entries(FIELDS))
      if (def === undefined && !(field in r)) problems.push(`${name}: "${field}" is required`);
  }
  return problems.length ? problems : null;
}

export const expandHome = (p) => (p === '~' ? os.homedir() : p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// Defaults filled in, paths with ~ expanded.
export function normalizeRemotes(value) {
  const out = {};
  for (const [name, r] of Object.entries(value ?? {})) {
    const full = { name };
    for (const [field, [, def]] of Object.entries(fieldsOf(r.kind))) full[field] = field in r ? r[field] : def;
    full.label ??= name;
    if (full.seed) full.seed = expandHome(full.seed);
    full.identity = expandHome(full.identity);
    out[name] = full;
  }
  return out;
}

// What a page may know of the remotes: no paths, no commands. `paid`: each
// new machine costs money, so the page asks first.
export const pageRemotes = (remotes) =>
  Object.values(remotes ?? {}).map((r) => {
    const kind = kindOf(r);
    return {
      name: r.name,
      label: r.label,
      color: r.color,
      noun: kind.noun,
      fullNoun: kind.fullNoun ?? kind.noun,
      lifetime: kind.lifetime(r),
      paid: r.kind === 'lunanode-ctl',
      plan: r.plan ?? null,
    };
  });
