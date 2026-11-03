// Open a URL with the OS default browser, not whatever browser shows the page.
import { spawn } from 'node:child_process';

export function openExternal(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [u.href]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', u.href]]
        : ['xdg-open', [u.href]];
  console.log(`open ${u.href}`);
  // Report failures: a silent `open` that does nothing is hard to tell apart
  // from a click that never arrived.
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => console.error(`open failed: ${e.message}`));
  child.on('exit', (code) => {
    if (code) console.error(`open exited ${code}: ${err.trim()}`);
  });
  child.unref();
}
