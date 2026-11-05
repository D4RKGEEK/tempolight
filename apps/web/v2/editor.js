// Full-screen editors (the room editor, the show editor, camera mapping): they take the whole content area, with
// their own top bar (back, title, actions) instead of the app's. enterEditor() marks the page; the function it
// returns puts it back (call it from destroy()). Styles: /v2/editor.css (the editor chrome and the room editor).
import { ensureCss, icon } from "/v2/shell.js";
import { esc } from "/app.js";

export function enterEditor(el, kind) {
  ensureCss("/v2/editor.css");
  document.body.dataset.editor = kind; el.classList.add("ed-page");
  return () => { if (document.body.dataset.editor === kind) delete document.body.dataset.editor; el.classList.remove("ed-page"); };
}

/** The editor's top bar: back link, an eyebrow + title (HTML), a slot after the title, and the actions on the right. */
export const edTop = ({ back = "#/lights", backLabel = "Back", eyebrow = "", title = "", after = "", actions = "" }) =>
  `<header class="ed-top"><a class="ed-back" href="${esc(back)}" aria-label="${esc(backLabel)}">${icon("back")}</a>
    <div class="ed-title">${eyebrow ? `<span class="ed-eyebrow">${esc(eyebrow)}</span>` : ""}${title}</div>${after}
    <div class="ed-act">${actions}</div></header>`;

// a few extra icons the editors use (24px stroke, same style as shell.js icons)
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ui-ic">${d}</svg>`;
export const EI = {
  pointer: svg('<path d="M5 3l14 7.5-6.2 1.6L10 18.5z"/>'),
  strip: svg('<path d="M4 17L20 7"/><circle cx="6.5" cy="15.4" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="17.5" cy="8.6" r="1"/>'),
  ring: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="4.5" r="1"/><circle cx="19.5" cy="12" r="1"/><circle cx="12" cy="19.5" r="1"/><circle cx="4.5" cy="12" r="1"/>'),
  matrix: svg('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>'),
  points: svg('<circle cx="6" cy="7" r="1.6"/><circle cx="17" cy="6" r="1.6"/><circle cx="11" cy="12" r="1.6"/><circle cx="6.5" cy="17.5" r="1.6"/><circle cx="17.5" cy="16.5" r="1.6"/>'),
  shapes: svg('<rect x="3.5" y="12.5" width="8" height="8" rx="1.5"/><circle cx="16.5" cy="7.5" r="4"/><path d="M15.5 20.5l3-5.5 3 5.5z"/>'),
  zone: svg('<path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="M13 4h7v7h-7zM4 13h7v7H4z" stroke-dasharray="2 2.2"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  minus: svg('<path d="M5 12h14"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'),
  fit: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  layouts: svg('<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/><rect x="13.5" y="14" width="7" height="6" rx="1.5"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  flash: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  split: svg('<path d="M12 3v18"/><path d="M8 7H4v10h4M16 7h4v10h-4"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
};
