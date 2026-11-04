// A small in-memory stand-in for Cloudflare D1, enough to run the Worker under Node: it reads the tables from
// schema.sql and runs the few kinds of statements the Worker uses (INSERT [OR REPLACE] ... VALUES, SELECT ... WHERE
// col = ? [AND ...] [ORDER BY col [DESC]] [LIMIT n], DELETE ... WHERE col <|=|> ?). Anything else throws, so a
// statement the fake doesn't understand (or a column that isn't in schema.sql) fails the test instead of passing quietly.
export function fakeD1(schemaSql) {
  const tables = new Map();
  for (const m of schemaSql.replace(/--[^\n]*/g, "").matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g)) {
    const cols = [], body = m[2]; let pk = null;
    for (const part of body.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean)) {
      const p = /^PRIMARY KEY \(([^)]+)\)$/.exec(part); if (p) { pk = p[1].split(",").map(s => s.trim()); continue; }
      const [name, ...rest] = part.split(/\s+/); cols.push(name); if (/PRIMARY KEY/.test(rest.join(" "))) pk = [name];
    }
    tables.set(m[1], { cols, pk, rows: [] });
  }
  const T = name => { const t = tables.get(name); if (!t) throw new Error(`no such table: ${name}`); return t; };
  const col = (t, c) => { if (!t.cols.includes(c)) throw new Error(`no such column: ${c}`); return c; };
  const where = (t, clause, args) => { if (!clause) return () => true;
    const conds = clause.split(/\s+AND\s+/i).map(c => { const m = /^(\w+)\s*(=|<|>|<=|>=)\s*\?$/.exec(c.trim()); if (!m) throw new Error(`fake D1 can't do: ${c}`); return { c: col(t, m[1]), op: m[2], v: args.shift() }; });
    return r => conds.every(({ c, op, v }) => op === "=" ? r[c] === v : op === "<" ? r[c] < v : op === ">" ? r[c] > v : op === "<=" ? r[c] <= v : r[c] >= v); };
  function exec(sql, args) {
    sql = sql.trim().replace(/\s+/g, " "); args = args.slice(); let m;
    if ((m = /^INSERT (OR REPLACE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql))) {
      const t = T(m[2]), cs = m[3].split(",").map(s => col(t, s.trim())), row = {}; cs.forEach((c, i) => { row[c] = args[i] ?? null; });
      for (const c of t.cols) if (!(c in row)) row[c] = null;
      const same = t.pk ? t.rows.findIndex(r => t.pk.every(k => r[k] === row[k])) : -1;
      if (same >= 0) { if (!m[1]) throw new Error("UNIQUE constraint failed"); t.rows[same] = row; } else t.rows.push(row);
      return { results: [], meta: { changes: 1 } };
    }
    if ((m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+)( DESC)?)?(?: LIMIT (\d+))?$/i.exec(sql))) {
      const t = T(m[2]), f = where(t, m[3], args); let rows = t.rows.filter(f);
      if (m[4]) { const c = col(t, m[4]), d = m[5] ? -1 : 1; rows = rows.slice().sort((a, b) => (a[c] < b[c] ? -d : a[c] > b[c] ? d : 0)); }
      if (m[6]) rows = rows.slice(0, Number(m[6]));
      const cs = m[1].trim() === "*" ? t.cols : m[1].split(",").map(s => col(t, s.trim()));
      return { results: rows.map(r => Object.fromEntries(cs.map(c => [c, r[c]]))), meta: {} };
    }
    if ((m = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(sql))) { const t = T(m[1]), f = where(t, m[2], args), n = t.rows.length; t.rows = t.rows.filter(r => !f(r)); return { results: [], meta: { changes: n - t.rows.length } }; }
    throw new Error(`fake D1 can't run: ${sql}`);
  }
  return {
    tables,
    prepare(sql) { let args = []; const st = { bind(...a) { args = a; return st; }, async first() { return exec(sql, args).results[0] ?? null; }, async all() { return exec(sql, args); }, async run() { return exec(sql, args); } }; return st; },
  };
}
