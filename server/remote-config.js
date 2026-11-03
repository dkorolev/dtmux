// The `remotes:` part of ~/.dtmux.yaml: machines a tab can live on instead
// of this one. Each remote is reached with plain `ssh`; how its machines are
// made and found is spelled out here, never assumed by the code.
//
//   remotes:
//     lunanode:                      # the name tabs remember; [a-z0-9-]
//       kind: lunanode-ctl           # VMs made by a lunanode-ctl controller
//       controller: [ssh, lunanode, lunanode-ctl]   # how to run the controller
//       seed: ~/.ssh/lunanode.seed   # caller seed, fed on stdin, never in argv
//       label: LunaNode              # optional; shown on the page
//       color: "#c58af9"             # optional; the tint of its tabs
//       plan: m.1s                   # optional; lunanode-ctl create --plan
//       image: Ubuntu 24.04          # optional; --image
//       ipv4: true                   # optional; --ipv4 (a public IPv4 to ssh to)
//       ttlSeconds: 86400            # optional; the VM is deleted after this
//       hostPrefix: dtmux            # optional; new VMs are <hostPrefix>-<8 hex>
//       user: ubuntu                 # optional; ssh login on the VM
//       identity: ~/.ssh/id_ed25519  # optional; ssh -i, the seed's own key
//       attach: <remote command>     # optional; what ssh runs there (see below)
import os from 'node:os';
import path from 'node:path';

// What runs on the VM: its own tmux, so the shells there keep running with
// the connection gone (a laptop asleep or rebooting, dtmux restarted) and
// dtmux joins them again later. Always tmux: it is installed when missing.
// Its status line is off (the page has tabs) and the mouse on (the wheel
// scrolls its history).
export const DEFAULT_ATTACH =
  'command -v tmux >/dev/null || { echo "Installing tmux..."; sudo -n apt-get install -y -qq tmux >/dev/null; }; ' +
  'exec tmux new-session -A -s dtmux \\; set -g status off \\; set -g mouse on';

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// field -> [check(value) -> error | null, default (undefined: required)]
const FIELDS = {
  kind: [(v) => (v === 'lunanode-ctl' ? null : 'must be "lunanode-ctl" (the only kind so far)'), undefined],
  controller: [
    (v) => (Array.isArray(v) && v.length && v.every(isStr) ? null : 'must be a non-empty list of words, e.g. [ssh, lunanode, lunanode-ctl]'),
    undefined,
  ],
  seed: [(v) => (isStr(v) ? null : 'must be the path of the caller seed file'), undefined],
  label: [(v) => (isStr(v) && v.length <= 40 ? null : 'must be a short name'), null],
  color: [(v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'must be a color like "#c58af9"'), '#c58af9'],
  plan: [(v) => (isStr(v) ? null : 'must be a plan name, e.g. m.1s'), 'm.1s'],
  image: [(v) => (isStr(v) ? null : 'must be an image name, e.g. Ubuntu 24.04'), 'Ubuntu 24.04'],
  ipv4: [(v) => (typeof v === 'boolean' ? null : 'must be true or false'), true],
  ttlSeconds: [
    (v) => (Number.isInteger(v) && v >= 60 && v <= 2592000 ? null : 'must be an integer from 60 to 2592000'),
    86400,
  ],
  hostPrefix: [(v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(v) ? null : 'must be lowercase letters, digits and dashes'), 'dtmux'],
  user: [(v) => (typeof v === 'string' && /^[a-z_][a-z0-9_.-]*$/i.test(v) ? null : 'must be a login name'), 'ubuntu'],
  identity: [(v) => (isStr(v) ? null : 'must be the path of an ssh private key'), null],
  attach: [(v) => (isStr(v) ? null : 'must be a shell command'), DEFAULT_ATTACH],
};

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
    for (const [field, v] of Object.entries(r)) {
      const spec = FIELDS[field];
      if (!spec) problems.push(`${name}: unknown key "${field}" (allowed: ${Object.keys(FIELDS).join(', ')})`);
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
    for (const [field, [, def]] of Object.entries(FIELDS)) full[field] = field in r ? r[field] : def;
    full.label ??= name;
    full.seed = expandHome(full.seed);
    full.identity = expandHome(full.identity);
    out[name] = full;
  }
  return out;
}

// What a page may know of the remotes: no paths, no commands.
export const pageRemotes = (remotes) =>
  Object.values(remotes ?? {}).map(({ name, label, color, plan, ttlSeconds }) => ({ name, label, color, plan, ttlSeconds }));
