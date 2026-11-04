// A Markdown + MDX renderer for the docs site (no dependencies), good enough for the pages in mintlify/: GitHub-style
// Markdown (headings, lists, tables, fenced code, blockquotes, autolinks), MDX comments, inline HTML (className becomes
// class) and the Mintlify components the pages use (Card, Columns/CardGroup, Steps, Tabs, CodeGroup, callouts,
// Accordion, Frame, Badge, Icon, ParamField/ResponseField, Expandable, Tooltip).
//   render(source, ctx) -> { html, headings: [{depth, id, text}], text: [{id, heading, text}] }
// ctx.link(href) rewrites a link (internal pages to /docs/...), ctx.icon(name, cls) returns an icon's SVG.
import { esc, highlight, langOf, LANG_NAMES } from "./highlight.js";

/** GitHub-style heading ids: lower case, punctuation dropped, spaces to dashes; repeats get -1, -2... */
export function slugger() {
  const seen = new Map();
  return text => {
    let s = String(text).toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const n = seen.get(s); seen.set(s, (n ?? -1) + 1); if (n !== undefined) s += "-" + (n + 1); return s;
  };
}
const stripTags = s => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export const plainText = stripTags;

// ---------------------------------------------------------------- JSX attributes
/** `title="x" cols={3} open` -> {title: "x", cols: 3, open: true} */
export function parseAttrs(s) {
  const o = {}, re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g; let m;
  while ((m = re.exec(s))) {
    const k = m[1]; let v = m[2] ?? m[3];
    if (v === undefined && m[4] !== undefined) { const x = m[4].trim(); v = /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x === "true" ? true : x === "false" ? false : /^(["'`]).*\1$/.test(x) ? x.slice(1, -1) : x; }
    if (v === undefined) v = true;
    o[k === "className" ? "class" : k] = v;
  }
  return o;
}
const attrHtml = a => Object.entries(a).filter(([, v]) => v !== false && v != null).map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${esc(v)}"`).join("");

// tags whose content is inline text (rendered without paragraphs); everything else holds blocks
const INLINE_HTML = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "span", "strong", "em", "b", "i", "code", "kbd", "small", "sup", "sub", "button", "label", "summary", "li", "td", "th", "figcaption", "mark", "u", "s"]);
const VOID_HTML = new Set(["br", "hr", "img", "input", "source", "meta", "link", "wbr"]);
const HTML_TAGS = new Set([...INLINE_HTML, ...VOID_HTML, "div", "section", "article", "aside", "header", "footer", "nav", "ul", "ol", "table", "thead", "tbody", "tr", "figure", "details", "picture", "video", "audio", "iframe", "blockquote", "pre", "dl", "dt", "dd", "main", "center"]);
const isComponent = n => /^[A-Z]/.test(n);

// ---------------------------------------------------------------- inline
function findClose(s, i, open, close) { // index of the bracket closing the one at i (skips code spans and escapes)
  let d = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "`") { const n = /^`+/.exec(s.slice(k))[0].length, e = s.indexOf("`".repeat(n), k + n); if (e > 0) { k = e + n - 1; continue; } }
    if (c === open) d++; else if (c === close && --d === 0) return k;
  }
  return -1;
}
function linkTarget(s) { // "url" or "url \"title\"" -> {href, title}
  const m = /^\s*<?([^\s>]*)>?(?:\s+["'(](.*)["')])?\s*$/.exec(s); return m ? { href: m[1], title: m[2] } : { href: s.trim() };
}
const PUNCT_ESC = /[\\`*_{}[\]()#+\-.!|<>~"'$&:=]/;

export function inline(s, ctx) {
  let out = "", i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i], rest = s.slice(i);
    if (c === "\\" && PUNCT_ESC.test(s[i + 1] || "")) { out += esc(s[i + 1]); i += 2; continue; }
    if (c === "\\" && s[i + 1] === "\n") { out += "<br>"; i += 2; continue; }
    if (c === "`") {
      const n = /^`+/.exec(rest)[0].length, e = s.indexOf("`".repeat(n), i + n);
      if (e > 0 && s[e + n] !== "`") { let code = s.slice(i + n, e); if (/^ .* $/.test(code)) code = code.slice(1, -1); out += `<code>${esc(code)}</code>`; i = e + n; continue; }
      out += esc("`".repeat(n)); i += n; continue;
    }
    if (c === "{" && rest.startsWith("{/*")) { const e = s.indexOf("*/}", i); if (e > 0) { i = e + 3; continue; } }
    if ((c === "!" && s[i + 1] === "[") || c === "[") {
      const st = c === "!" ? i + 1 : i, e = findClose(s, st, "[", "]");
      if (e > 0 && s[e + 1] === "(") {
        const pe = findClose(s, e + 1, "(", ")");
        if (pe > 0) {
          const label = s.slice(st + 1, e), { href, title } = linkTarget(s.slice(e + 2, pe));
          if (c === "!") out += `<img src="${esc(ctx.link(href, "image"))}" alt="${esc(stripTags(label))}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" decoding="async">`;
          else out += anchor(ctx.link(href), inline(label, ctx), title);
          i = pe + 1; continue;
        }
      }
    }
    if (c === "<") {
      let m = /^<((?:https?|mailto):[^\s<>]+)>/.exec(rest);
      if (m) { out += anchor(ctx.link(m[1]), esc(m[1])); i += m[0].length; continue; }
      m = /^<!--[\s\S]*?-->/.exec(rest); if (m) { i += m[0].length; continue; }
      m = /^<(\/?)([A-Za-z][\w.]*)((?:\s+[^<>]*?)?)\s*(\/?)>/.exec(rest);
      if (m && (isComponent(m[2]) || HTML_TAGS.has(m[2].toLowerCase()))) {
        const [all, closing, name, attrs, self] = m;
        if (isComponent(name)) {
          if (closing) { i += all.length; continue; }
          // an inline component: find its closing tag on this line
          let inner = "", len = all.length;
          if (!self) { const ce = s.indexOf(`</${name}>`, i + all.length); if (ce > 0) { inner = s.slice(i + all.length, ce); len = ce + name.length + 3 - i; } }
          out += inlineComponent(name, parseAttrs(attrs), inner, ctx); i += len; continue;
        }
        const a = parseAttrs(attrs || ""); if (a.href) a.href = ctx.link(a.href); if (a.src) a.src = ctx.link(a.src, "image");
        out += closing ? `</${name}>` : `<${name}${attrHtml(a)}${self && !VOID_HTML.has(name) ? `></${name}>` : ">"}`; i += all.length; continue;
      }
    }
    if (c === "&") { const m = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.exec(rest); if (m) { out += m[0]; i += m[0].length; continue; } }
    if ((c === "*" || c === "_" || c === "~") && !(c === "_" && /[\p{L}\p{N}]/u.test(s[i - 1] || ""))) {
      const run = /^([*_~])\1*/.exec(rest)[0], n = Math.min(run.length, c === "~" ? 2 : 3);
      if (!(c === "~" && n < 2) && !/\s/.test(s[i + n] || " ")) {
        const d = c.repeat(n); let e = i + n;
        while ((e = s.indexOf(d, e + 1)) > 0) { // a closing run not after a space (and, for _, not before a letter)
          if (/\s/.test(s[e - 1]) || (c === "_" && /[\p{L}\p{N}]/u.test(s[e + n] || ""))) continue;
          if (s[e + n] === c && n < 3) { e++; continue; } break;
        }
        if (e > 0) {
          const inner = inline(s.slice(i + n, e), ctx);
          out += c === "~" ? `<del>${inner}</del>` : n === 3 ? `<strong><em>${inner}</em></strong>` : n === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
          i = e + n; continue;
        }
      }
      out += esc(run); i += run.length; continue;
    }
    if (c === "h" && /^https?:\/\//.test(rest) && !/[\w/"'=]/.test(s[i - 1] || "")) {
      const m = /^https?:\/\/[^\s<>()`*]+[^\s<>()`*.,;:!?'"]/.exec(rest);
      if (m) { out += anchor(ctx.link(m[0]), esc(m[0])); i += m[0].length; continue; }
    }
    if (c === " " && rest.startsWith("  \n")) { out += "<br>\n"; i += 3; continue; }
    // plain run of text
    const m = /^[^\\`{[!<&*_~h \n]+/.exec(rest);
    if (m) { out += esc(m[0]); i += m[0].length; } else { out += esc(c); i++; }
  }
  return out;
}
function anchor(href, html, title) {
  const ext = /^https?:\/\//.test(href);
  return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' target="_blank" rel="noopener"' : ""}>${html}</a>`;
}
function inlineComponent(name, a, inner, ctx) {
  switch (name) {
    case "Icon": return ctx.icon(a.icon, "ic-inline", a.size);
    case "Badge": return `<span class="badge${a.color ? " badge-" + esc(a.color) : ""}">${inline(inner, ctx)}</span>`;
    case "Tooltip": return `<span class="tooltip" title="${esc(a.tip || "")}">${inline(inner, ctx)}</span>`;
    case "Kbd": return `<kbd>${inline(inner, ctx)}</kbd>`;
    default: return inline(inner, ctx);
  }
}

// ---------------------------------------------------------------- blocks
const indentOf = l => /^ */.exec(l)[0].length;
const dedent = (lines, n) => lines.map(l => l.slice(Math.min(n, indentOf(l))));
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const FENCE_RE = /^( *)(`{3,}|~{3,})(.*)$/;

class Renderer {
  constructor(ctx) { this.ctx = ctx; this.headings = []; this.sections = [{ id: "", heading: "", text: "" }]; this.slug = slugger(); this.uid = 0; }
  addText(t) { const s = this.sections[this.sections.length - 1]; s.text += " " + stripTags(t).replace(/\s+/g, " "); }

  blocks(src) { return this.parse(src.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n")); }

  parse(lines) {
    let out = "", i = 0;
    const blank = l => !l || !l.trim();
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { i++; continue; }
      const t = line.trim();
      // MDX comment
      if (t.startsWith("{/*")) { while (i < lines.length && !lines[i].includes("*/}")) i++; i++; continue; }
      if (t.startsWith("<!--")) { while (i < lines.length && !lines[i].includes("-->")) i++; i++; continue; }
      // fenced code
      let m = FENCE_RE.exec(line);
      if (m) {
        const ind = m[1].length, fence = m[2], info = m[3].trim(), body = []; i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^[`~]+$/.test(lines[i].trim()))) { body.push(lines[i].slice(Math.min(ind, indentOf(lines[i])))); i++; }
        i++; out += this.code(body.join("\n"), info); continue;
      }
      // heading
      m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
      if (m && indentOf(line) < 4) { out += this.heading(m[1].length, m[2]); i++; continue; }
      // rule
      if (/^([-*_])(\s*\1){2,}$/.test(t)) { out += "<hr>"; i++; continue; }
      // JSX / HTML block
      if (/^<\/?[A-Za-z]/.test(t) && !/^<(https?|mailto):/.test(t)) {
        const r = this.element(lines, i); if (r) { out += r.html; i = r.next; continue; }
      }
      // table
      if (t.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const rows = [line]; i += 2; const align = lines[i - 1];
        while (i < lines.length && lines[i].includes("|") && !blank(lines[i])) rows.push(lines[i++]);
        out += this.table(rows, align); continue;
      }
      // blockquote
      if (t.startsWith(">")) {
        const body = []; while (i < lines.length && lines[i].trim().startsWith(">")) body.push(lines[i++].trim().replace(/^> ?/, ""));
        out += `<blockquote>${this.parse(body)}</blockquote>`; continue;
      }
      // list
      if (LIST_RE.test(line)) { const r = this.list(lines, i); out += r.html; i = r.next; continue; }
      // paragraph
      const para = [];
      while (i < lines.length && !blank(lines[i])) {
        const l = lines[i], lt = l.trim();
        if (para.length && (FENCE_RE.test(l) || /^#{1,6}\s/.test(lt) || lt.startsWith(">") || (LIST_RE.test(l) && (!/^\d/.test(lt) || /^1[.)]/.test(lt))) || (/^<\/?[A-Z]/.test(lt)) || /^<(div|h\d|p|table|details)\b/i.test(lt))) break;
        para.push(lt); i++;
      }
      const html = inline(para.join("\n"), this.ctx); this.addText(html);
      out += /^<img [^>]*>$/.test(html.trim()) ? `<p class="img">${html}</p>` : `<p>${html}</p>`;
    }
    return out;
  }

  heading(depth, text) {
    const html = inline(text, this.ctx), id = this.slug(stripTags(html));
    if (depth <= 3) this.headings.push({ depth, id, text: stripTags(html).trim() });
    this.sections.push({ id, heading: stripTags(html).trim(), text: "" });
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">${this.ctx.icon("link", "ic")}</a>${html}</h${depth}>`;
  }

  code(body, info) {
    const [lang = "", ...restInfo] = info.split(/\s+/); let title = restInfo.join(" ").replace(/^title=["']?|["']$/g, "").replace(/\{[^}]*\}/g, "").trim();
    if (!title && lang.includes(":")) title = lang.split(":")[1];
    const l = lang.split(":")[0].replace(/^\{|\}$/g, "");
    if (l === "mermaid") { this.ctx.mermaid = true; return `<div class="mermaid-wrap"><pre class="mermaid" data-src="${esc(body)}">${esc(body)}</pre></div>`; }
    this.addText(body.slice(0, 200));
    return codeBlock(body, l, title, this.ctx);
  }

  table(rows, alignRow) {
    const cells = r => { let s = r.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
      const out = []; let cur = "", tick = 0; for (let k = 0; k < s.length; k++) { const ch = s[k];
        if (ch === "\\" && s[k + 1] === "|") { cur += "\\|"; k++; continue; } if (ch === "`") tick ^= 1;
        if (ch === "|" && !tick) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(x => x.trim().replace(/\\\|/g, "|")); };
    const al = cells(alignRow).map(a => a.startsWith(":") && a.endsWith(":") ? "center" : a.endsWith(":") ? "right" : "");
    const td = (tag, c, k) => `<${tag}${al[k] ? ` style="text-align:${al[k]}"` : ""}>${inline(c, this.ctx)}</${tag}>`;
    const [head, ...body] = rows, html = `<div class="table-wrap"><table><thead><tr>${cells(head).map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${body.map(r => `<tr>${cells(r).map((c, k) => td("td", c, k)).join("")}</tr>`).join("")}</tbody></table></div>`;
    this.addText(html.slice(0, 4000)); return html;
  }

  list(lines, i) {
    const first = LIST_RE.exec(lines[i]), base = first[1].length, ordered = /\d/.test(first[2]), start = ordered ? parseInt(first[2], 10) : 1;
    const items = []; let loose = false;
    while (i < lines.length) {
      const m = LIST_RE.exec(lines[i]);
      if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
      const w = m[0].length === m[1].length + m[2].length ? m[0].length + 1 : m[0].length, body = [lines[i].slice(m[0].length)]; i++;
      let sawBlank = false;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) { sawBlank = true; body.push(""); i++; continue; }
        if (indentOf(l) >= Math.min(w, base + 2)) { if (sawBlank && indentOf(l) < w && LIST_RE.test(l) && indentOf(l) === base) break; body.push(l); sawBlank = false; i++; continue; }
        if (!sawBlank && !LIST_RE.test(l) && !/^\s*(#{1,6}\s|```|~~~|>|<[A-Z])/.test(l) && !l.trim().startsWith("|")) { body.push(l); i++; continue; } // lazy continuation
        break;
      }
      while (body.length && !body[body.length - 1].trim()) { body.pop(); if (i < lines.length && LIST_RE.test(lines[i]) && indentOf(lines[i]) === base) loose = true; }
      if (body.some((l, k) => !l.trim() && k > 0 && k < body.length - 1 && !LIST_RE.test(body[k + 1] || "") )) loose = true;
      items.push([body[0], ...dedent(body.slice(1), w)]);
    }
    const lis = items.map(b => {
      let html = this.parse(b);
      if (!loose) html = html.replace(/<p>([\s\S]*?)<\/p>/g, (x, inner) => inner + "\n").trim();
      const task = /^\[( |x)\]\s/i.exec(html); if (task) html = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ` + html.slice(task[0].length);
      return `<li>${html}</li>`;
    }).join("");
    return { html: ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${lis}</ol>` : `<ul>${lis}</ul>`, next: i };
  }

  /** A JSX component or HTML element starting at lines[i]: {html, next} or null when it isn't one. */
  element(lines, i) {
    // gather the opening tag (it may span lines)
    let text = lines.slice(i).join("\n"); const startCol = indentOf(lines[i]); text = text.slice(startCol);
    const om = /^<(\/?)([A-Za-z][\w.]*)((?:\s+(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^}]*\})*?)?)\s*(\/?)>/.exec(text);
    if (!om) return null;
    const [all, closing, name, attrs, self] = om, comp = isComponent(name);
    if (!comp && !HTML_TAGS.has(name.toLowerCase())) return null;
    if (closing) return { html: comp ? "" : `</${name}>`, next: i + 1 };
    const lineOf = off => i + (text.slice(0, off).match(/\n/g) || []).length;
    const a = parseAttrs(attrs || "");
    if (self || VOID_HTML.has(name.toLowerCase())) {
      const after = text.slice(all.length).split("\n")[0];
      if (after.trim()) return null; // something follows on the line: a paragraph with inline HTML
      return { html: comp ? this.component(name, a, "") : (a.src && (a.src = this.ctx.link(a.src, "image")), `<${name}${attrHtml(a)}>`), next: lineOf(all.length) + 1 };
    }
    // find the matching closing tag
    const re = new RegExp(`<(/?)${name.replace(".", "\\.")}(?=[\\s>/])[^>]*?(/?)>`, "g"); re.lastIndex = all.length; let d = 1, m, end = -1;
    // skip fenced code inside the element
    const fences = []; { const fr = /^ *(```|~~~)[^\n]*\n[\s\S]*?^ *\1 *$/gm; let f; while ((f = fr.exec(text))) fences.push([f.index, f.index + f[0].length]); }
    while ((m = re.exec(text))) { if (fences.some(([s, e]) => m.index > s && m.index < e)) continue; if (m[2]) continue; d += m[1] ? -1 : 1; if (!d) { end = m.index; break; } }
    if (end < 0) return null;
    const inner = text.slice(all.length, end), closeEnd = end + name.length + 3, next = lineOf(closeEnd) + 1;
    const after = text.slice(closeEnd).split("\n")[0]; if (after.trim() && !comp) return null;
    if (comp) return { html: this.component(name, a, inner), next };
    if (a.href) a.href = this.ctx.link(a.href);
    const tag = name.toLowerCase();
    if (INLINE_HTML.has(tag) || !inner.includes("\n")) { const h = inline(inner.trim().replace(/\n\s*/g, " "), this.ctx); this.addText(h); return { html: `<${name}${attrHtml(a)}>${h}</${name}>`, next }; }
    return { html: `<${name}${attrHtml(a)}>${this.innerBlocks(inner)}</${name}>`, next };
  }
  innerBlocks(inner) { const ls = inner.replace(/^\n/, "").split("\n"); const n = Math.min(...ls.filter(l => l.trim()).map(indentOf), 99); return this.parse(dedent(ls, n === 99 ? 0 : n)); }

  component(name, a, inner) {
    const ctx = this.ctx, body = () => this.innerBlocks(inner), ic = (n, c = "ic") => n ? ctx.icon(n, c) : "";
    switch (name) {
      case "Columns": case "CardGroup": return `<div class="cols cols-${Number(a.cols) || 2}">${body()}</div>`;
      case "Card": {
        const href = a.href ? ctx.link(a.href) : "", tag = href ? "a" : "div", ext = /^https?:/.test(href);
        const inside = `${a.img ? `<img class="card-img" src="${esc(ctx.link(a.img, "image"))}" alt="" loading="lazy">` : ""}${a.icon ? `<span class="card-icon">${ic(a.icon)}</span>` : ""}<span class="card-text"><span class="card-title">${inline(a.title || "", ctx)}</span><span class="card-body">${body()}</span>${a.cta ? `<span class="card-cta">${esc(a.cta)} ${ic("arrow-right")}</span>` : ""}</span>${href ? `<span class="card-arrow">${ic(ext ? "arrow-up-right" : "chevron-right")}</span>` : ""}`;
        this.addText(a.title || "");
        return `<${tag} class="card${a.horizontal ? " card-h" : ""}"${href ? ` href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ""}` : ""}>${inside}</${tag}>`;
      }
      case "Note": case "Tip": case "Warning": case "Info": case "Check": case "Danger": case "Callout": {
        const kind = name === "Callout" ? (a.type || "info").toLowerCase() : name.toLowerCase(), icon = a.icon || { note: "info", tip: "lightbulb", warning: "triangle-alert", info: "info", check: "circle-check", danger: "octagon-alert" }[kind] || "info";
        return `<div class="callout callout-${kind}" role="note"><span class="callout-icon">${ic(icon)}</span><div class="callout-body">${a.title ? `<strong>${esc(a.title)}</strong>` : ""}${body()}</div></div>`;
      }
      case "Steps": return `<div class="steps">${body()}</div>`;
      case "Step": { const h = a.title ? this.heading(Number(a.titleSize?.replace?.("h", "")) || 3, a.title).replace(/^<h(\d)/, '<h$1 class="step-title"') : ""; return `<div class="step">${a.icon ? `<span class="step-icon">${ic(a.icon)}</span>` : '<span class="step-num"></span>'}<div class="step-body">${h}${body()}</div></div>`; }
      case "Tabs": { const id = "tabs" + ++this.uid, tabs = []; const re = /<Tab\b([^>]*)>([\s\S]*?)<\/Tab>/g; let m;
        while ((m = re.exec(inner))) tabs.push({ a: parseAttrs(m[1]), html: this.innerBlocks(m[2]) });
        return `<div class="mdx-tabs" data-tabs><div class="tab-list" role="tablist">${tabs.map((t, k) => `<button type="button" role="tab" id="${id}-t${k}" aria-controls="${id}-p${k}" aria-selected="${k === 0}">${t.a.icon ? ic(t.a.icon) : ""}${esc(t.a.title || "Tab " + (k + 1))}</button>`).join("")}</div>${tabs.map((t, k) => `<div class="tab-panel" role="tabpanel" id="${id}-p${k}" aria-labelledby="${id}-t${k}"${k ? " hidden" : ""}>${t.html}</div>`).join("")}</div>`; }
      case "Tab": return body();
      case "CodeGroup": { const blocks = []; const fr = /^ *(```|~~~)([^\n]*)\n([\s\S]*?)\n *\1 *$/gm; let m; const src = dedent(inner.split("\n"), Math.min(...inner.split("\n").filter(l => l.trim()).map(indentOf))).join("\n");
        while ((m = fr.exec(src))) { const [lang = "", ...t] = m[2].trim().split(/\s+/); blocks.push({ lang, title: t.join(" ") || LANG_NAMES[langOf(lang)] || lang || "Code", code: m[3] }); }
        return codeGroup(blocks, ctx, "cg" + ++this.uid); }
      case "Accordion": return `<details class="accordion"${a.defaultOpen ? " open" : ""}><summary>${a.icon ? ic(a.icon) : ""}<span>${esc(a.title || "")}</span>${ic("chevron-down", "ic chev")}</summary><div class="accordion-body">${body()}</div></details>`;
      case "AccordionGroup": return `<div class="accordion-group">${body()}</div>`;
      case "Expandable": return `<details class="expandable"${a.defaultOpen ? " open" : ""}><summary>${ic("chevron-right", "ic chev")}Show ${esc(a.title || "properties")}</summary><div class="expandable-body">${body()}</div></details>`;
      case "Frame": return `<figure class="frame">${body().replace(/^<p class="img">([\s\S]*)<\/p>$/, "$1")}${a.caption ? `<figcaption>${inline(a.caption, ctx)}</figcaption>` : ""}</figure>`;
      case "ParamField": case "ResponseField": {
        const where = a.path ? "path" : a.query ? "query" : a.header ? "header" : a.body ? "body" : "", fname = a.name || a.path || a.query || a.header || a.body || "";
        return `<div class="field"><div class="field-head"><code class="field-name">${esc(fname)}</code>${a.type ? `<span class="field-type">${esc(a.type)}</span>` : ""}${where ? `<span class="field-in">${where}</span>` : ""}${a.required ? '<span class="field-req">required</span>' : ""}${a.default !== undefined ? `<span class="field-def">default: <code>${esc(a.default)}</code></span>` : ""}</div><div class="field-desc">${body()}</div></div>`;
      }
      case "Badge": case "Icon": case "Tooltip": return `<p>${inlineComponent(name, a, inner.trim(), ctx)}</p>`;
      case "Update": return `<div class="update"><div class="update-label">${esc(a.label || "")}${a.description ? `<span>${esc(a.description)}</span>` : ""}</div><div class="update-body">${body()}</div></div>`;
      default: return `<div class="mdx-${esc(name.toLowerCase())}">${body()}</div>`;
    }
  }
}

/** One code block: the header (title or language, copy button) and the highlighted code. */
export function codeBlock(code, lang, title, ctx) {
  const l = langOf(lang), label = title || "";
  return `<div class="code${label ? " has-title" : ""}">${label ? `<div class="code-head"><span class="code-title">${esc(label)}</span></div>` : ""}<button class="copy" type="button" aria-label="Copy code" data-copy>${ctx.icon("copy", "ic")}${ctx.icon("check", "ic ok")}</button><pre><code${l ? ` class="lang-${l}"` : ""}>${highlight(code.replace(/\n+$/, ""), lang)}</code></pre></div>`;
}
/** Several code blocks in tabs (CodeGroup, and the API pages' samples). blocks: [{title, lang, code}] */
export function codeGroup(blocks, ctx, id) {
  return `<div class="code code-group" data-tabs><div class="code-head tab-list" role="tablist">${blocks.map((b, k) => `<button type="button" role="tab" id="${id}-t${k}" aria-controls="${id}-p${k}" aria-selected="${k === 0}">${esc(b.title)}</button>`).join("")}</div><button class="copy" type="button" aria-label="Copy code" data-copy>${ctx.icon("copy", "ic")}${ctx.icon("check", "ic ok")}</button>${blocks.map((b, k) => `<pre class="tab-panel" role="tabpanel" id="${id}-p${k}" aria-labelledby="${id}-t${k}"${k ? " hidden" : ""}><code${langOf(b.lang) ? ` class="lang-${langOf(b.lang)}"` : ""}>${highlight(b.code.replace(/\n+$/, ""), b.lang)}</code></pre>`).join("")}</div>`;
}

/** Front matter: {data, body} */
export function frontMatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src.replace(/\r\n?/g, "\n")); if (!m) return { data: {}, body: src };
  const data = {}; for (const l of m[1].split("\n")) { const k = /^([\w-]+):\s*(.*)$/.exec(l); if (k) { let v = k[2].trim(); if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1); else if (v === "true" || v === "false") v = v === "true"; data[k[1]] = v; } }
  return { data, body: src.replace(/\r\n?/g, "\n").slice(m[0].length) };
}

export function render(src, ctx) {
  const r = new Renderer(ctx), html = r.blocks(src);
  return { html, headings: r.headings, sections: r.sections.map(s => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() })).filter(s => s.heading || s.text), mermaid: !!ctx.mermaid };
}
