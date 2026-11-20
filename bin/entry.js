// Entry point of the single binary only. The checkout runs bin/dtmux.js,
// server/daemon.js and bin/dtmux-remote.js directly; here they share one
// executable and the first argument says which.
//
// The macOS app (macos/dtmux-app.swift) still runs `<program> <bin/dtmux.js>
// <op>`, from when <program> was node. The script path is ignored.

function legacyScript(arg) {
  return typeof arg === 'string' && (arg.endsWith('/dtmux.js') || arg.endsWith('\\dtmux.js'));
}

// No top-level await: the binary is a CommonJS single-executable, which
// cannot load one.
async function main() {
  if (legacyScript(process.argv[2])) process.argv.splice(2, 1);
  const op = process.argv[2];
  if (op === '--daemon' || op === '--remote') {
    process.argv.splice(2, 1);
    await import(op === '--daemon' ? '../server/daemon.js' : '../bin/dtmux-remote.js');
  } else {
    await import('../bin/dtmux.js');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
