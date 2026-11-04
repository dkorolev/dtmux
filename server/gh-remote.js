// `gh` on a remote tab's machine: see who it is logged in as, log it in with
// this Mac's GitHub token (instrument), or log it out again (un-instrument).
//
// Instrumenting copies the token `gh auth token` gives here; it is checked
// first in a clean container (gh-check.js), and goes to the machine on ssh's
// stdin only, never in a command line (the machine may be shared). There
// `gh` keeps it in ~/.config/gh/hosts.yml (no keyring), and git uses it for
// github.com (`gh auth setup-git`). gh is installed into ~/.local/bin when
// the machine has none that runs (a snap gh will not run for a home outside
// /home, as on a devbox host). Un-instrumenting logs every github.com account out
// and takes gh out of git's credential helpers; gh itself stays.
import { execFile } from 'node:child_process';
import { runOnMachine } from './remote-ssh.js';
import { checkToken } from './gh-check.js';

const GH_PATH = 'export PATH="$HOME/.local/bin:$PATH"';

const accountsIn = (text) => [...String(text).matchAll(/Logged in to github\.com account (\S+)/g)].map((m) => m[1]);
const scopesIn = (text) =>
  /Token scopes:\s*(.*)/.exec(String(text))?.[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) ?? null;

function gh(args) {
  return new Promise((resolve) =>
    execFile('gh', args, { timeout: 15000 }, (err, out, stderr) => resolve({ code: err ? (err.code === 'ENOENT' ? 127 : err.code ?? 1) : 0, out: String(out), err: String(stderr) })),
  );
}

// This Mac: { ok, login, scopes, error }.
export async function hostStatus() {
  const r = await gh(['auth', 'status', '--active', '--hostname', 'github.com']);
  if (r.code === 127) return { ok: false, error: 'gh is not installed on this Mac' };
  const text = r.out + r.err;
  const [login] = accountsIn(text);
  if (!login) return { ok: false, error: 'gh is not logged in on this Mac (gh auth login)' };
  return { ok: true, login, scopes: scopesIn(text) };
}

const hostToken = async () => {
  const r = await gh(['auth', 'token', '--hostname', 'github.com']);
  return r.code === 0 ? r.out.trim() : null;
};

// The token, checked in the clean container: { ok, login, scopes, error }.
export async function cleanCheck() {
  const token = await hostToken();
  if (!token) return { ok: false, error: 'no token from gh on this Mac' };
  return checkToken(token);
}

// The machine: { ok, gh: bool, logins: [...], error }.
export async function machineStatus(remote, host, address) {
  const r = await runOnMachine(remote, host, address, `${GH_PATH}; gh --version >/dev/null 2>&1 || { echo NO-GH; exit 0; }; gh auth status --hostname github.com 2>&1; true`);
  if (r.code !== 0) return { ok: false, error: lastLine(r) };
  if (r.out.includes('NO-GH')) return { ok: true, gh: false, logins: [] };
  return { ok: true, gh: true, logins: accountsIn(r.out) };
}

const INSTALL_GH = `
if ! gh --version >/dev/null 2>&1; then
  case "$(uname -m)" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) echo "no gh build for $(uname -m)" >&2; exit 3;; esac
  v=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p' | head -n1)
  [ -n "$v" ] || { echo "could not find the latest gh release" >&2; exit 3; }
  echo "installing gh $v into ~/.local/bin"
  mkdir -p "$HOME/.local/bin"; t=$(mktemp -d)
  curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_\${v}_linux_$a.tar.gz" | tar -xz -C "$t"
  mv "$t/gh_\${v}_linux_$a/bin/gh" "$HOME/.local/bin/gh"; rm -rf "$t"
  hash -r # not the gh bash looked up before
fi`;

// Log the machine's gh in with this Mac's token, after the clean check.
// -> { ok, login, log, error }.
export async function instrument(remote, host, address) {
  const token = await hostToken();
  if (!token) return { ok: false, error: 'no token from gh on this Mac' };
  const check = await checkToken(token);
  if (!check.ok) return { ok: false, error: `the token failed the clean check: ${check.error}` };
  const script = `set -e; ${GH_PATH}
IFS= read -r TOKEN
${INSTALL_GH}
printf '%s\\n' "$TOKEN" | gh auth login --hostname github.com --git-protocol https --with-token
gh auth setup-git --hostname github.com
gh auth status --hostname github.com 2>&1`;
  const r = await runOnMachine(remote, host, address, script, { stdin: `${token}\n`, timeoutMs: 180000 });
  const logins = accountsIn(r.out);
  if (r.code !== 0 || !logins.includes(check.login)) return { ok: false, error: lastLine(r), log: tail(r) };
  return { ok: true, login: check.login, log: tail(r) };
}

// Log the machine's gh out of github.com, and out of git. -> { ok, error }.
export async function uninstrument(remote, host, address) {
  const script = `${GH_PATH}
if gh --version >/dev/null 2>&1; then
  for u in $(gh auth status --hostname github.com 2>&1 | sed -n 's/.*Logged in to github.com account \\([^ ]*\\).*/\\1/p'); do
    gh auth logout --hostname github.com --user "$u" >/dev/null 2>&1 || true
  done
fi
git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
git config --global --unset-all credential.https://gist.github.com.helper 2>/dev/null || true
if gh --version >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then echo STILL-LOGGED-IN; exit 1; fi
echo done`;
  const r = await runOnMachine(remote, host, address, script, { timeoutMs: 60000 });
  return r.code === 0 ? { ok: true } : { ok: false, error: lastLine(r) };
}

const lastLine = (r) => (r.err || r.out).trim().split('\n').pop()?.slice(0, 300) || `exit ${r.code}`;
const tail = (r) => (r.out + r.err).trim().split('\n').slice(-12);
