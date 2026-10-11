// Who funded each pump.fun creator wallet? For every creator (signer of a create) in shadow
// recordings: the wallet's oldest transaction and the account that sent it its first SOL. Serial
// scammers make a fresh wallet for each launch, but often fund them from the same source.
// Read-only (RPC). Resumable: wallets already in the output file are skipped.
// Usage: node tools/funders-fetch.mjs <out.jsonl> <shadow.jsonl> [more…]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [OUT, ...FILES] = process.argv.slice(2);
const key = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'helius-key.txt'), 'utf8').trim();
const RPC = `https://mainnet.helius-rpc.com/?api-key=${key}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) { await sleep(500); continue; }
      return j.result;
    } catch { await sleep(1000); }
  }
  return null;
}

const wallets = new Set();
for (const f of FILES) {
  for await (const line of readline.createInterface({ input: fs.createReadStream(f) })) {
    if (line.startsWith('{"e":"c"')) wallets.add(JSON.parse(line).user);
  }
}
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).w);
const todo = [...wallets].filter((w) => !done.has(w));
console.log(`portfeli twórców: ${wallets.size}, już zrobionych: ${done.size}, do pobrania: ${todo.length}`);
const out = fs.createWriteStream(OUT, { flags: 'a' });

async function funderOf(w) {
  // Oldest signature (page back at most 5 × 1000; busier wallets are not fresh launch wallets).
  let before, oldest = null, n = 0;
  for (let p = 0; p < 5; p++) {
    const page = await rpc('getSignaturesForAddress', [w, { limit: 1000, before }]);
    if (!page) return { w, err: 'rpc' };
    n += page.length;
    if (page.length) oldest = page[page.length - 1];
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    if (p === 4) return { w, nSigs: n, many: true };
  }
  if (!oldest) return { w, nSigs: 0 };
  const tx = await rpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
  if (!tx) return { w, nSigs: n, err: 'tx' };
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions)];
  let funder = null, lamports = 0, method = null;
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (ix.program !== 'system' || !info) continue;
    const to = info.destination ?? info.newAccount;
    if (to === w && (info.source || info.fundingAccount)) { funder = info.source ?? info.fundingAccount; lamports = Number(info.lamports || 0); method = ix.parsed.type; break; }
  }
  if (!funder) {
    // Fall back to the fee payer of the first transaction when it is someone else.
    const payer = tx.transaction.message.accountKeys[0]?.pubkey;
    if (payer && payer !== w) { funder = payer; method = 'feePayer'; }
  }
  return { w, funder, lamports, method, slot: tx.slot, bt: tx.blockTime, nSigs: n };
}

let i = 0;
const CONC = 4;
const t0 = Date.now();
async function worker() {
  while (i < todo.length) {
    const w = todo[i++];
    const r = await funderOf(w);
    out.write(JSON.stringify(r) + '\n');
    if (i % 500 === 0) console.log(`${new Date().toISOString().slice(11, 19)} ${i}/${todo.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
out.end();
console.log('KONIEC');
