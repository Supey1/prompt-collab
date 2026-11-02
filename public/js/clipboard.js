// Shared by every page with a Copy button.

// Copy text to the clipboard. Browsers only allow this right after a click, so
// nothing here waits on the network first (Safari is strictest about that).
// The clipboard API only exists on https:// and localhost; on a plain http://
// network address we fall back to the older execCommand copy.
export function copyText(text) {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  // While a dialog (like Share) is open, the rest of the page is inert and can't
  // be selected, so the temporary textarea has to go inside the open dialog.
  const host = document.querySelector('dialog[open]') || document.body;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  const focused = document.activeElement;
  host.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS Safari ignores select()
  let ok = false;
  // execCommand can report success even when nothing was selected, so check first.
  if (document.activeElement === ta && ta.selectionEnd - ta.selectionStart === text.length) {
    try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  }
  ta.remove();
  focused?.focus?.();
  return ok;
}
