import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageKind, savePastedImage } from '../server/paste-image.js';
import { armPasteFlash, fileFromPasteEvent, imageMessage, PASTE_FLASH_FADE_MS, PASTE_FLASH_HOLD_MS } from '../public/paste-image.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('imageKind knows a png and rejects text', () => {
  assert.equal(imageKind(png), 'png');
  assert.equal(imageKind(Buffer.from('hello world!!')), null);
  assert.equal(imageKind(Buffer.alloc(0)), null);
});

test('savePastedImage writes a png and refuses anything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmux-paste-'));
  const file = savePastedImage(png, dir);
  assert.equal(fs.readFileSync(file).equals(png), true);
  assert.match(path.basename(file), /^paste-\d+-[0-9a-f]{8}\.png$/);
  assert.throws(() => savePastedImage(Buffer.from('not an image!!'), dir), /not an image/);
});

test('a paste with text is left alone, an image file is taken', () => {
  const image = { size: 4, type: 'image/png' };
  const data = {
    getData: (type) => (type === 'text/plain' ? '' : ''),
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
  };
  assert.equal(fileFromPasteEvent(data), image);
  assert.equal(
    fileFromPasteEvent({
      getData: () => 'image.png',
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
    }),
    image,
  );
  assert.equal(
    fileFromPasteEvent({
      getData: () => '/tmp/shot.png',
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
    }),
    null,
  );
  assert.equal(fileFromPasteEvent(null), null);
});

test('a pasted image is held for half a second, then fades over a quarter', () => {
  assert.equal(PASTE_FLASH_HOLD_MS, 500);
  assert.equal(PASTE_FLASH_FADE_MS, 250);
  const handles = [];
  const stop = armPasteFlash({
    holdMs: PASTE_FLASH_HOLD_MS,
    fadeMs: PASTE_FLASH_FADE_MS,
    onFade: () => {},
    onDone: () => {},
    schedule: (_fn, ms) => {
      handles.push({ ms });
      return handles.length;
    },
    cancel: (id) => handles.push({ canceled: id }),
  });
  assert.deepEqual(
    handles.map((h) => h.ms),
    [500, 750],
  );
  stop();
  assert.deepEqual(handles.slice(2), [{ canceled: 1 }, { canceled: 2 }]);
});

test('imageMessage refuses an empty or oversized image', () => {
  assert.equal(imageMessage(new Uint8Array()), null);
  assert.equal(imageMessage(new Uint8Array(12 * 1024 * 1024 + 1)), null);
  const msg = imageMessage(Uint8Array.from(png));
  assert.equal(msg.t, 'paste-image');
  assert.equal(Buffer.from(msg.data, 'base64').equals(png), true);
});
