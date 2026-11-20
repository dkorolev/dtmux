// Stand-in for `node-pty` inside the single binary. The real package is
// extracted to disk (pty-cache.js) and loaded from there; esbuild aliases
// `node-pty` to this file only when it builds the binary. The checkout
// keeps importing node-pty itself.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ensurePty } from './pty-cache.js';

const dir = ensurePty();
const require = createRequire(pathToFileURL(path.join(dir, 'package.json')));
const pty = require(path.join(dir, 'lib', 'index.js'));
export default pty;
