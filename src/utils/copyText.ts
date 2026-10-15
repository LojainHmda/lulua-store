// Copies text to the clipboard. navigator.clipboard only exists in a secure
// context (HTTPS or localhost) — opening the admin over a LAN IP such as
// http://192.168.x.x leaves it undefined — and it can also reject when the
// click's user activation has lapsed (e.g. after awaiting a network write).
// Either way, fall back to the legacy hidden-textarea + execCommand("copy")
// path, which works on plain HTTP. Resolves false only if both fail.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  const previousFocus = document.activeElement as HTMLElement | null;
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  previousFocus?.focus?.();
  return ok;
}
