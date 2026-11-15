// A pasted screenshot has no text, and the terminal only carries text. Save
// the image where the program can read it and hand that path back; the Cursor
// agent turns a pasted path of an image file into an attachment. On a remote
// tab the program is on the machine, so the file is copied there first.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellQuote } from './agent-resume.js';
import { STATE_DIR } from './paths.js';
import { sshArgs, KNOWN_HOSTS } from './remote-ssh.js';
import { MUX_DIR } from './remote-kinds.js';

export const MAX_PASTE_BYTES = 12 * 1024 * 1024;

const PASTE_NAME = /^paste-\d+-[0-9a-f]{8}\.(png|jpg|gif|webp|bmp|tiff)$/;

// The extension the bytes actually are, or null. The browser's mime type is
// not trusted: only a real image is written out.
export function imageKind(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_PASTE_BYTES) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )
    return 'tiff';
  return null;
}

// Write `bytes` under `dir` and return the absolute path.
export function savePastedImage(bytes, dir) {
  const ext = imageKind(bytes);
  if (!ext) throw new Error('That paste is not an image dtmux can save.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

export const pasteDir = () => path.join(STATE_DIR, 'pastes');

// Copy a file this module just wrote onto the machine. Resolves to the
// absolute path there (the shell on that machine expands $HOME).
export function uploadPaste(remote, host, address, localPath) {
  const name = path.basename(localPath);
  if (!PASTE_NAME.test(name)) return Promise.reject(new Error('bad paste name'));
  fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(KNOWN_HOSTS), { recursive: true });
  const script = `d="$HOME/.dtmux/pastes"; mkdir -p "$d" && cat > "$d/${name}" && printf %s "$d/${name}"`;
  const args = ['-o', 'BatchMode=yes', ...sshArgs(remote, host, address), `bash -c ${shellQuote(script)}`];
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out copying the image to the machine.'));
    }, 20000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const where = out.trim();
      if (code === 0 && where.startsWith('/')) resolve(where);
      else reject(new Error(err.trim() || `Could not copy the image (${code}).`));
    });
    const input = fs.createReadStream(localPath);
    input.on('error', (e) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    });
    input.pipe(child.stdin);
  });
}
