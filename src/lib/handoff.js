// In-memory hand-off of a file between tools (e.g. "Open result in Reader").
// Nothing is persisted: the bytes only live in this tab's memory.
let pending = null;

export function setPending(file) {
  pending = file; // { bytes: Uint8Array, name: string }
}

export function takePending() {
  const p = pending;
  pending = null;
  return p;
}

export function go(route, file) {
  if (file) setPending(file);
  if (location.hash === route) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = route;
}
