// A small syntax highlighter for the docs site's code blocks (no dependencies): enough for the languages the pages use
// (JavaScript/TypeScript, JSON, shell and PowerShell, YAML, HTML/XML, CSS, C/C++, Python). Each language is a list of
// [class, regex] rules tried in order at every position; text no rule matches is left plain. Output is escaped HTML
// with <span class="t-…"> around tokens (the colours are in docs.css).
export const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const kw = words => new RegExp(`\\b(?:${words.split(" ").join("|")})\\b`, "y");
const STR = [/"(?:[^"\\\n]|\\.)*"/y, /'(?:[^'\\\n]|\\.)*'/y];
const NUM = /\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy;
const JS_KW = "await async break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as interface type enum implements declare readonly private public protected keyof";
const LANGS = {
  js: [["c", /\/\/[^\n]*/y], ["c", /\/\*[\s\S]*?\*\//y], ["s", /`(?:[^`\\]|\\.)*`/y], ["s", STR[0]], ["s", STR[1]],
    ["k", kw(JS_KW)], ["b", kw("true false null undefined NaN Infinity")], ["n", NUM], ["f", /[A-Za-z_$][\w$]*(?=\s*\()/y], ["p", /(?<=\.)[A-Za-z_$][\w$]*/y]],
  json: [["p", /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y], ["s", STR[0]], ["b", kw("true false null")], ["n", /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/iy], ["c", /\/\/[^\n]*/y]],
  sh: [["c", /(?<=^|\s)#[^\n]*/my], ["s", STR[0]], ["s", /'[^']*'/y], ["v", /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$\(/y],
    ["k", kw("if then else elif fi for while do done case esac in function export local return sudo")], ["o", /(?<=\s)--?[A-Za-z][\w-]*/y],
    ["f", /(?<=^|[|;&(]\s*|^\s+)[A-Za-z_./][\w./-]*(?=\s|$)/my], ["n", /\b\d+(?:\.\d+)*\b/y]],
  ps: [["c", /#[^\n]*/y], ["s", STR[0]], ["s", /'[^']*'/y], ["v", /\$[A-Za-z_][\w:]*/y], ["o", /(?<=\s)-[A-Za-z][\w-]*/y],
    ["f", /(?<=^|[|;]\s*)[A-Za-z][\w.-]*(?=\s|$)/my], ["n", /\b\d+\b/y]],
  yaml: [["c", /(?<=^|\s)#[^\n]*/my], ["p", /(?<=^\s*(?:- )?)[\w.@/-]+(?=\s*:(?:\s|$))/my], ["s", STR[0]], ["s", STR[1]],
    ["b", kw("true false null yes no on off")], ["n", /(?<=:\s*|-\s+)-?\d+(?:\.\d+)?(?=\s*$)/my], ["o", /^\s*-(?=\s)/my]],
  html: [["c", /<!--[\s\S]*?-->/y], ["t", /<\/?[A-Za-z][\w:-]*|\/?>/y], ["a", /(?<=\s)[A-Za-z_:@][\w:.-]*(?==)/y], ["s", STR[0]], ["s", STR[1]]],
  css: [["c", /\/\*[\s\S]*?\*\//y], ["s", STR[0]], ["s", STR[1]], ["p", /[\w-]+(?=\s*:[^{};]*[;}])/y], ["k", /@[\w-]+/y],
    ["n", /-?\d*\.?\d+(?:px|rem|em|%|s|ms|vh|vw|deg|fr)?\b/y], ["v", /#[\da-f]{3,8}\b/iy], ["t", /[.#]?[A-Za-z][\w-]*(?=[^{}]*\{)/y]],
  cpp: [["c", /\/\/[^\n]*/y], ["c", /\/\*[\s\S]*?\*\//y], ["k", /#\s*\w+/y], ["s", STR[0]], ["s", /'(?:[^'\\]|\\.)'/y],
    ["k", kw("auto bool break case char class const constexpr continue default delete do double else enum extern float for if inline int long namespace new nullptr private protected public return short signed sizeof static struct switch template this typedef typename uint8_t uint16_t uint32_t int16_t int32_t size_t union unsigned using virtual void volatile while override")],
    ["b", kw("true false NULL")], ["n", NUM], ["f", /[A-Za-z_]\w*(?=\s*\()/y]],
  py: [["c", /#[^\n]*/y], ["s", /("""|''')[\s\S]*?\1/y], ["s", /[fbr]?"(?:[^"\\\n]|\\.)*"/y], ["s", /[fbr]?'(?:[^'\\\n]|\\.)*'/y], ["k", /@[\w.]+/y],
    ["k", kw("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield")],
    ["b", kw("True False None")], ["n", NUM], ["f", /[A-Za-z_]\w*(?=\s*\()/y]],
};
const ALIAS = { javascript: "js", mjs: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js", json5: "json", jsonc: "json", bash: "sh", shell: "sh", zsh: "sh", console: "sh", sh: "sh",
  powershell: "ps", pwsh: "ps", ps1: "ps", bat: "ps", cmd: "ps", yml: "yaml", yaml: "yaml", xml: "html", svg: "html", vue: "html", html: "html", css: "css", scss: "css",
  c: "cpp", "c++": "cpp", cpp: "cpp", h: "cpp", ino: "cpp", arduino: "cpp", python: "py", py: "py", ini: "yaml", toml: "yaml", dockerfile: "sh", docker: "sh", nginx: "sh", caddy: "sh", text: null, txt: null, "": null };
export const LANG_NAMES = { js: "JavaScript", json: "JSON", sh: "Shell", ps: "PowerShell", yaml: "YAML", html: "HTML", css: "CSS", cpp: "C++", py: "Python" };
export const langOf = l => { const k = String(l || "").toLowerCase(); return k in ALIAS ? ALIAS[k] : LANGS[k] ? k : null; };

/** Highlight `code` as language `lang`; returns HTML. Unknown languages are only escaped. */
export function highlight(code, lang) {
  const rules = LANGS[langOf(lang)]; if (!rules) return esc(code);
  let out = "", i = 0, plain = "";
  const flush = () => { if (plain) { out += esc(plain); plain = ""; } };
  outer: while (i < code.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i; const m = re.exec(code);
      if (m && m.index === i && m[0].length) { flush(); out += `<span class="t-${cls}">${esc(m[0])}</span>`; i += m[0].length; continue outer; }
    }
    // skip a whole word at once, so a rule can't match from the middle of one
    const w = /[\w$]+/y; w.lastIndex = i; const m = w.exec(code);
    if (m && m.index === i) { plain += m[0]; i += m[0].length; } else { plain += code[i]; i++; }
  }
  flush(); return out;
}
