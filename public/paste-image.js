// Cmd+V in the page is a browser paste, and xterm.js pastes only text/plain.
// A screenshot is an image and nothing else, so that paste is empty and the
// program never sees it. Take the image here instead; the server stores it
// and answers with a path, which this types into the pane.

const MAX_PASTE_BYTES = 12 * 1024 * 1024;

// The image in a paste event. A path or any other real text stays a text
// paste. A screenshot is an image and, in some browsers, also the bare name
// "image.png", which is not a file the program can read.
export function fileFromPasteEvent(data) {
  if (!data) return null;
  const text = (data.getData?.('text/plain') ?? '').trim();
  const items = data.items ? Array.from(data.items) : [];
  let file = null;
  for (const item of items) {
    if (item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
      const got = item.getAsFile?.();
      if (got && got.size > 0) {
        file = got;
        break;
      }
    }
  }
  if (!file) return null;
  if (text && (/[/\\]/.test(text) || text.includes(' ') || text.length > 80 || !/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(text)))
    return null;
  return file;
}

function bytesToBase64(bytes) {
  const chunk = 0x4000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// An image on the system clipboard, when the paste event did not carry one
// (some browsers omit image items when the target is a text field).
async function readClipboardImage() {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const text = await (await item.getType('text/plain')).text();
      if (text.trim()) return null;
    }
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!blob || blob.size === 0) continue;
    const ext = type.split('/')[1] || 'img';
    return new File([blob], `paste.${ext}`, { type });
  }
  return null;
}

export function imageMessage(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_PASTE_BYTES) return null;
  return { t: 'paste-image', data: bytesToBase64(bytes) };
}

// `onFile(file)` receives the image. `root` is an element that contains the
// terminal. Cmd+V with no paste event (the browser dropped the image) is
// read from the clipboard a moment later.
export function attachImagePaste(root, onFile) {
  let sawPaste = false;
  root.addEventListener(
    'paste',
    (e) => {
      sawPaste = true;
      const file = fileFromPasteEvent(e.clipboardData);
      if (file) {
        e.preventDefault();
        e.stopPropagation();
        onFile(file);
        return;
      }
      const text = e.clipboardData?.getData?.('text/plain') ?? '';
      if (text.trim()) return;
      // No text and no image in the event: still don't hand an empty paste
      // to the program. The clipboard itself may hold the screenshot.
      e.preventDefault();
      e.stopPropagation();
      readClipboardImage().then((img) => img && onFile(img)).catch(() => {});
    },
    true,
  );
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.type !== 'keydown' || e.repeat) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return;
      sawPaste = false;
      setTimeout(() => {
        if (sawPaste) return;
        readClipboardImage().then((img) => img && onFile(img)).catch(() => {});
      }, 30);
    },
    true,
  );
}

export async function fileToMessage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return imageMessage(bytes);
}
