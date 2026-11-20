// Build dist/dtmux: one executable that does not read node_modules.
//
//   node script/build-binary.mjs            # write dist/dtmux
//   node script/build-binary.mjs --install  # also install it for this user
//
// The executable is the official Node binary for this machine with dtmux
// injected (Node's single-executable application). Homebrew's node is a
// small program linked against Homebrew libraries, so it is not the one
// that gets shipped. node-pty's native files cannot be loaded from inside
// the executable; they are embedded and written to ~/.dtmux/native on use.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR } from '../server/assets.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const install = process.argv.includes('--install');
const version = process.version; // v25.5.0
const platform = process.platform;
const arch = process.arch;

function die(msg) {
  console.error(`dtmux: ${msg}`);
  process.exit(1);
}

function walkFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs));
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function commit() {
  const opts = { cwd: root, encoding: 'utf8' };
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(hash)) return '';
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim() ? '-dirty' : '';
    return hash + dirty;
  } catch {
    return '';
  }
}

function officialNode() {
  const name = `node-${version}-${platform}-${arch}`;
  const bin = path.join(dist, name, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(bin)) return bin;
  const tar = path.join(dist, `${name}.tar.gz`);
  const url = `https://nodejs.org/dist/${version}/${name}.tar.gz`;
  fs.mkdirSync(dist, { recursive: true });
  console.log(`downloading ${url}`);
  execFileSync('curl', ['-fL', '--retry', '3', '-o', tar, url], { stdio: 'inherit' });
  execFileSync('tar', ['-xzf', tar, '-C', dist], { stdio: 'inherit' });
  fs.rmSync(tar, { force: true });
  if (!fs.existsSync(bin)) die(`Node's archive had no ${path.relative(dist, bin)}`);
  return bin;
}

function entitlementsOf(nodeBin) {
  // codesign prints the plist on stdout and a note on stderr, and the note
  // is not a failure. Keep the plist's allow-jit keys: without them the
  // binary crashes as soon as it runs.
  // `:-` is the form that still prints XML. The textual form from `-` is
  // not something codesign will take back as --entitlements.
  const child = spawnSync('codesign', ['-d', '--entitlements', ':-', nodeBin], { encoding: 'utf8' });
  const xml = String(child.stdout || '');
  if (!xml.startsWith('<?xml')) die(`could not read the Node binary's entitlements: ${String(child.stderr || '').slice(0, 300)}`);
  return xml;
}

function sign(file, entitlements) {
  const plist = `${file}.entitlements`;
  fs.writeFileSync(plist, entitlements);
  execFileSync('codesign', ['--sign', '-', '--force', '--entitlements', plist, file], { stdio: 'inherit' });
  fs.rmSync(plist, { force: true });
}

fs.mkdirSync(dist, { recursive: true });
const bundle = path.join(dist, 'dtmux.cjs');
await build({
  entryPoints: [path.join(root, 'bin', 'entry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  legalComments: 'none',
  // repoRoot() reads import.meta.url only in the checkout. The bundle never
  // takes that branch (it is a single executable), so the empty value is unused.
  logOverride: { 'empty-import-meta': 'silent' },
  alias: { 'node-pty': path.join(root, 'server', 'pty-loader.js') },
  plugins: [
    {
      name: 'optional-native',
      setup(b) {
        // ws optionally requires these and catches the failure. A missing
        // module inside the binary has to throw, not be looked up on disk.
        b.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({ path: args.path, namespace: 'optional-native' }));
        b.onLoad({ filter: /.*/, namespace: 'optional-native' }, () => ({
          contents: 'throw new Error("optional native addon is not in the dtmux binary");',
          loader: 'js',
        }));
      },
    },
  ],
});

const bundled = fs.readFileSync(bundle, 'utf8');
if (!bundled.includes('createRequire')) die('the bundle lost the node-pty loader');
if (bundled.includes('node-pty/lib')) die('node-pty was bundled; its native half would not load');

const assets = {};
for (const file of walkFiles(path.join(root, 'public'))) {
  assets[`public/${path.relative(path.join(root, 'public'), file).split(path.sep).join('/')}`] = file;
}
for (const rel of Object.values(VENDOR)) assets[rel] = path.join(root, rel);
const pty = path.join(root, 'node_modules', 'node-pty');
assets['pty/package.json'] = path.join(pty, 'package.json');
for (const file of walkFiles(path.join(pty, 'lib'))) {
  if (file.endsWith('.map') || file.endsWith('.test.js')) continue;
  assets[`pty/${path.relative(pty, file).split(path.sep).join('/')}`] = file;
}
const prebuild = path.join(pty, 'prebuilds', `${platform}-${arch}`);
for (const name of ['pty.node', 'spawn-helper']) {
  const file = path.join(prebuild, name);
  if (!fs.existsSync(file)) die(`node-pty has no ${platform}-${arch} ${name}`);
  assets[`pty/prebuilds/${platform}-${arch}/${name}`] = file;
}
const commitFile = path.join(dist, 'commit.txt');
fs.writeFileSync(commitFile, `${commit()}\n`);
assets['meta/commit'] = commitFile;

const nodeBin = officialNode();
const entitlements = entitlementsOf(nodeBin);
const output = path.join(dist, 'dtmux');
fs.rmSync(output, { force: true });
const config = path.join(dist, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({
  main: bundle,
  executable: nodeBin,
  output,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
}, null, 2));
console.log('injecting dtmux into the Node binary');
execFileSync(nodeBin, ['--build-sea', config], { stdio: 'inherit' });
sign(output, entitlements);
fs.chmodSync(output, 0o755);
const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(0);
console.log(`wrote ${output} (${mb} MB)`);

if (install) installBinary(output, entitlements);

function installBinary(bin, entitlements) {
  const apps = path.join(os.homedir(), 'Library', 'Application Support', 'dtmux');
  const dest = path.join(apps, 'dtmux-bin');
  fs.mkdirSync(apps, { recursive: true });
  const tmp = `${dest}.new`;
  fs.copyFileSync(bin, tmp);
  fs.chmodSync(tmp, 0o755);
  sign(tmp, entitlements);
  fs.renameSync(tmp, dest);

  const local = path.join(os.homedir(), '.local', 'bin', 'dtmux');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  execFileSync('ln', ['-sfn', dest, local]);
  const brew = '/opt/homebrew/bin/dtmux';
  try {
    if (fs.lstatSync(brew).isSymbolicLink()) execFileSync('ln', ['-sfn', dest, brew]);
  } catch {
    // No Homebrew shim. ~/.local/bin is enough when it is on PATH.
  }

  const state = path.join(os.homedir(), '.dtmux');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'use-binary'), `${dest}\n`);

  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.dima.dtmux.plist');
  if (fs.existsSync(plist)) {
    const script = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments:2', plist], { encoding: 'utf8' }).trim();
    if (script.endsWith(`${path.sep}dtmux.js`) || script.endsWith('/dtmux.js')) {
      const quoted = dest.replaceAll("'", `'\\''`);
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ProgramArguments:1 '${quoted}'`, plist], { stdio: 'inherit' });
    }
  }
  console.log(`installed ${dest}`);
  console.log(`a checkout daemon hands over to it on the next start (${path.join(state, 'use-binary')})`);
}
