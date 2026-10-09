// Offline check of src/shreds.mjs on real pump.fun launch transactions: fetches recent launches
// (raw wire bytes), packs them into a bincode Vec<Entry> exactly like a shred-stream entry, decodes
// it and compares with what the RPC says (mint, creator, the logged instruction name).
// Usage: node tools/shreds-selftest.mjs [count=12] [--from=<shadow.jsonl>: launches from a recording]
import fs from 'node:fs';
import path from 'node:path';
import { parseEntries, pumpLaunch, PUMP } from '../src/shreds.mjs';
import { extractPumpEvents } from '../src/lib/events.js';

const N = Number(process.argv.filter((a) => !a.startsWith('--'))[2] || 12);
const FROM = process.argv.find((a) => a.startsWith('--from='))?.slice(7);
const key = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'helius-key.txt'), 'utf8').trim();
const rpc = async (method, params) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await new Promise((x) => setTimeout(x, 1500)); continue; }
    return (await r.json()).result;
  }
};
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

// Recent pump.fun transactions; keep the launches (and a few ordinary trades as noise).
let sigs = await rpc('getSignaturesForAddress', [PUMP, { limit: 300 }]);
if (FROM) {
  const lines = fs.readFileSync(FROM, 'utf8').split('\n').filter((l) => l.startsWith('{"e":"c"') || l.startsWith('{"e":"t"'));
  const cs = lines.filter((l) => l.startsWith('{"e":"c"')).slice(-N).map((l) => ({ signature: JSON.parse(l).sig }));
  const ts = lines.filter((l) => l.startsWith('{"e":"t"')).slice(-6).map((l) => ({ signature: JSON.parse(l).sig }));
  sigs = [...ts.slice(0, 3), ...cs, ...ts.slice(3)];
}
const raws = [], expect = [];
let other = 0;
for (const s of sigs) {
  if (s.err) continue;
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  if (!tx) continue;
  const logs = tx.meta.logMessages || [];
  const isCreate = logs.some((l) => l === 'Program log: Instruction: Create' || l === 'Program log: Instruction: CreateV2');
  if (!isCreate && other >= 6) continue;
  if (!isCreate) other++;
  raws.push(Buffer.from(tx.transaction[0], 'base64'));
  const meta = tx.meta.postTokenBalances?.find((b) => b.mint && b.mint.endsWith('pump'))?.mint ?? null;
  const devEv = extractPumpEvents(logs).filter((e) => e.name === 'TradeEvent' && e.data.is_buy).pop();
  expect.push({ sig: s.signature, isCreate, mintHint: meta, ixName: logs.find((l) => /Instruction: Create/.test(l)) ?? null, devVS: devEv ? Number(devEv.data.virtual_sol_reserves) : 30e9 });
  if (expect.filter((x) => x.isCreate).length >= N) break;
}
// Two entries, transactions split between them.
const half = raws.length >> 1;
const entry = (txs) => Buffer.concat([u64(1), Buffer.alloc(32, 7), u64(txs.length), ...txs]);
const buf = Buffer.concat([u64(2), entry(raws.slice(0, half)), entry(raws.slice(half))]);
const txs = parseEntries(buf);
let ok = 0, bad = 0;
for (let i = 0; i < txs.length; i++) {
  const l = pumpLaunch(txs[i]);
  const e = expect[i];
  const good = e.isCreate ? Boolean(l) && l.sig === e.sig && (!e.mintHint || l.mint === e.mintHint) && Math.abs(l.vS - e.devVS) / e.devVS < 0.002 : !l;
  good ? ok++ : bad++;
  if (e.isCreate) console.log(`${good ? 'OK ' : 'ŹLE'} ${e.ixName?.split(': ').pop()} ${l ? `mint ${l.mint.slice(0, 8)}… twórca ${l.creator.slice(0, 6)}… zakup twórcy ${l.devSol.toFixed(3)} SOL (rezerwa wyliczona ${(l.vS / 1e9).toFixed(3)} vs zdarzenie ${(e.devVS / 1e9).toFixed(3)}) mayhem=${l.mayhem} „${l.symbol}”` : 'nie rozpoznano'}`);
}
console.log(`\nTransakcji w sztucznym wpisie: ${txs.length} (oczekiwano ${raws.length}); poprawnie: ${ok}, błędnie: ${bad}`);
