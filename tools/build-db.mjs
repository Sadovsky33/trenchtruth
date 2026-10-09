// Builds TrenchTruth's launch history (data/launches.jsonl) from shadow recordings and the
// funder lookups (tools/funders-fetch.mjs): one line per non-mayhem launch {mint, w, funder, t, dead},
// plus one line {pro} per professional sniper (bought in the creation slot of ≥4 creators' coins).
// Usage: node tools/build-db.mjs <funders.jsonl> <out.jsonl> <shadow.jsonl> [more…]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [FUNDERS, OUT, ...FILES] = process.argv.slice(2);
const funderOf = new Map();
for (const l of fs.readFileSync(FUNDERS, 'utf8').split('\n')) { if (l) { const x = JSON.parse(l); if (x.funder) funderOf.set(x.w, x.funder); } }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT);
const creatorsOf = new Map();
let n = 0;
for (const f of FILES) {
  const byMint = new Map();
  let end = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(f) })) {
    if (line.startsWith('{"e":"c"')) { const c = JSON.parse(line); byMint.set(c.mint, { c, tr: [] }); end = Math.max(end, c.r); }
    else if (line.startsWith('{"e":"t"')) { const t = JSON.parse(line); end = Math.max(end, t.r); byMint.get(t.mint)?.tr.push(t); }
  }
  for (const { c, tr } of byMint.values()) {
    for (const t of tr) {
      if (t.s !== c.s) break;
      if (t.b && t.u !== c.user) { if (!creatorsOf.has(t.u)) creatorsOf.set(t.u, new Set()); creatorsOf.get(t.u).add(c.user); }
    }
    if (c.mm || c.r > end - 6 * 60_000) continue;
    let last = null;
    for (const t of tr) { if (t.r > c.r + 300_000) break; last = t; }
    const dead = ((last ? last.vS : c.vS) - 30e9) < 0.3e9;
    out.write(JSON.stringify({ mint: c.mint, w: c.user, funder: funderOf.get(c.user) ?? null, t: c.r, dead }) + '\n');
    n++;
  }
}
let pros = 0;
for (const [w, s] of creatorsOf) if (s.size >= 4) { out.write(JSON.stringify({ pro: w }) + '\n'); pros++; }
out.end();
console.log(`zapisano ${n} monet i ${pros} zawodowych snajperów do ${OUT}`);
