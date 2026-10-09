// Records pump.fun events at "processed" commitment with the exact arrival time of each
// transaction, plus slot-start times, so the position our own buy would have reached inside a
// creation slot can be estimated later (the analysis scripts).
// Usage: node tools/record-launches.mjs [minutes]  (writes data/shadow-<time>.jsonl)
import fs from 'node:fs';
import path from 'node:path';
import { extractPumpEventsDetailed, PUMP_PROGRAM_ID } from '../src/lib/events.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const key = fs.readFileSync(path.join(ROOT, 'helius-key.txt'), 'utf8').trim();
const minutes = Number(process.argv[2] || 45);
const OUT = path.join(ROOT, 'data', `shadow-${new Date().toISOString().slice(0, 16).replace(':', '')}.jsonl`);
const out = fs.createWriteStream(OUT);
let ws, n = 0;
const big = (k, v) => (typeof v === 'bigint' ? Number(v) : v);
function connect() {
  ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${key}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'processed' }] }));
    out.write(JSON.stringify({ e: 'open', r: Date.now() }) + '\n');
  };
  ws.onmessage = (m) => {
    const r = Date.now();
    const msg = JSON.parse(m.data);
    if (msg.method === 'slotNotification') { out.write(JSON.stringify({ e: 's', s: msg.params.result.slot, r }) + '\n'); return; }
    if (msg.method !== 'logsNotification') return;
    const v = msg.params.result.value;
    if (v.err) return;
    const s = msg.params.result.context.slot;
    const { events } = extractPumpEventsDetailed(v.logs);
    for (const ev of events) {
      const d = ev.data;
      if (ev.name === 'CreateEvent') out.write(JSON.stringify({ e: 'c', s, r, sig: v.signature, mint: d.mint, user: d.user, creator: d.creator, vS: d.virtual_sol_reserves, vT: d.virtual_token_reserves, rT: d.real_token_reserves, mm: d.is_mayhem_mode ?? null }, big) + '\n');
      else if (ev.name === 'TradeEvent') { n++; out.write(JSON.stringify({ e: 't', s, r, sig: v.signature, mint: d.mint, b: d.is_buy ? 1 : 0, sol: d.sol_amount, tok: d.token_amount, u: d.user, vS: d.virtual_sol_reserves, vT: d.virtual_token_reserves, rS: d.real_sol_reserves, rT: d.real_token_reserves, fb: d.fee_basis_points }, big) + '\n'); }
      else if (ev.name === 'CompleteEvent') out.write(JSON.stringify({ e: 'g', s, r, mint: d.mint }) + '\n');
    }
  };
  ws.onclose = () => { out.write(JSON.stringify({ e: 'close', r: Date.now() }) + '\n'); setTimeout(connect, 1000); };
  ws.onerror = () => {};
}
connect();
setInterval(() => console.log(`${new Date().toISOString().slice(11, 19)} transakcji: ${n}`), 300000).unref();
setTimeout(() => { out.end(() => { console.log(`Zapisano: ${OUT}`); process.exit(0); }); }, minutes * 60000);
