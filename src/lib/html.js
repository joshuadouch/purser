// Tiny HTML templating: html`...` escapes every value unless it is already
// trusted markup (Raw), so pages are built from strings without an XSS hole.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Raw(String(s ?? ""));

export function esc(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join("");
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += esc(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// Plain text with line breaks and links, for ticket messages and notes.
export function textBlock(s) {
  const safe = esc(s ?? "");
  const linked = safe.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`,
  );
  return raw(linked.replace(/\r?\n/g, "<br>"));
}

export const attrs = (o) =>
  raw(
    Object.entries(o)
      .filter(([, v]) => v !== false && v !== null && v !== undefined)
      .map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`))
      .join(" "),
  );
