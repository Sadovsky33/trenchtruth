#!/usr/bin/env node
// How much earlier does a fast feed show new pump.fun coins than our Helius websocket? Read-only:
// nothing is signed or sent. Both feeds run side by side; every launch seen on both is matched by
// signature and the difference in arrival time on this server is reported.
// Fast feed, one of:
//   --grpc=HOST:PORT  Jito shredstream-proxy (or a compatible fork, e.g. LocalShred) running on this
//                     server: SubscribeEntries, decoded with src/shreds.mjs. Needs
//                     `npm install` (optional deps @grpc/grpc-js, @grpc/proto-loader).
//   --ws=FILE         a JSON WebSocket feed of decoded launches; FILE holds the full URL incl. key
//                     (kept out of the command line and logs). Messages with {sig, events:[{type:'create', mint}]}.
// Usage: node tools/feed-probe.mjs (--grpc=127.0.0.1:9999 | --ws=fast-feed.txt) [minutes=30]
import fs from 'node:fs';
import path from 'node:path';
import { parseEntries, pumpLaunch, PUMP } from '../src/shreds.mjs';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const MIN = Number(process.argv.filter((a) => !a.startsWith('--'))[2] || 30);
const ROOT = path.resolve(import.meta.dirname, '..');
const key = fs.readFileSync(path.join(ROOT, 'helius-key.txt'), 'utf8').trim();
const OUT = path.join(import.meta.dirname, 'logs', `feed-probe-${new Date().toISOString().slice(0, 16).replace(':', '')}.jsonl`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT);
const seen = new Map(); // sig -> { fast, helius, slot, mint }
const note = (sig, field, r, extra = {}) => {
  const x = seen.get(sig) || {};
  if (x[field] === undefined) x[field] = r;
  Object.assign(x, extra);
  seen.set(sig, x);
  if (x.fast !== undefined && x.helius !== undefined && !x.done) { x.done = true; out.write(JSON.stringify({ sig, ...x }) + '\n'); }
};

// Helius websocket at "processed" (what our earlier bot used).
function helius() {
  const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${key}`);
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
  ws.onmessage = (m) => {
    const r = Date.now();
    const msg = JSON.parse(m.data);
    if (msg.method !== 'logsNotification') return;
    const v = msg.params.result.value;
    if (v.err || !v.logs.some((l) => l === 'Program log: Instruction: Create' || l === 'Program log: Instruction: CreateV2')) return;
    note(v.signature, 'helius', r, { slot: msg.params.result.context.slot });
  };
  ws.onclose = () => setTimeout(helius, 1000);
  ws.onerror = () => {};
}

async function grpcFeed(target) {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const proto = path.join(import.meta.dirname, '..', 'src', 'shredstream.proto');
  const pkg = grpc.loadPackageDefinition(loader.loadSync(proto, { keepCase: true, longs: Number }));
  const client = new pkg.shredstream.ShredstreamProxy(target, grpc.credentials.createInsecure());
  const sub = () => {
    const call = client.SubscribeEntries({});
    call.on('data', (e) => {
      const r = Date.now();
      let txs;
      try { txs = parseEntries(e.entries); } catch { stats.badEntries++; return; }
      stats.entries++;
      for (const tx of txs) { const l = pumpLaunch(tx); if (l) note(l.sig, 'fast', r, { mint: l.mint, devSol: +l.devSol.toFixed(3), fastSlot: Number(e.slot) }); }
    });
    call.on('error', () => setTimeout(sub, 1000));
    call.on('end', () => setTimeout(sub, 1000));
  };
  sub();
}

function wsFeed(file) {
  const url = fs.readFileSync(path.resolve(ROOT, file), 'utf8').trim();
  const ws = new WebSocket(url);
  ws.onmessage = (m) => {
    const r = Date.now();
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    for (const ev of msg.events || []) if (ev.type === 'create' && msg.sig) note(msg.sig, 'fast', r, { mint: ev.mint, fastSlot: msg.slot });
  };
  ws.onclose = () => setTimeout(() => wsFeed(file), 1000);
  ws.onerror = () => {};
}

const stats = { entries: 0, badEntries: 0 };
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
function report(final) {
  const both = [...seen.values()].filter((x) => x.fast !== undefined && x.helius !== undefined);
  const lead = both.map((x) => x.helius - x.fast);
  const onlyFast = [...seen.values()].filter((x) => x.fast !== undefined && x.helius === undefined).length;
  const onlyHelius = [...seen.values()].filter((x) => x.helius !== undefined && x.fast === undefined).length;
  console.log(`${final ? 'KONIEC ' : ''}${new Date().toISOString().slice(11, 19)} | nowych monet w obu źródłach: ${both.length} (tylko szybkie: ${onlyFast}, tylko Helius: ${onlyHelius}) | szybkie źródło wcześniej o: mediana ${q(lead, 0.5)} ms, 10%: ${q(lead, 0.1)}, 90%: ${q(lead, 0.9)}${stats.entries ? ` | wpisów ${stats.entries}, błędnych ${stats.badEntries}` : ''}`);
}

helius();
if (arg('grpc')) await grpcFeed(arg('grpc'));
else if (arg('ws')) wsFeed(arg('ws'));
else { console.log('Podaj --grpc=HOST:PORT albo --ws=PLIK'); process.exit(1); }
setInterval(() => report(false), 60_000);
setTimeout(() => { report(true); out.end(); process.exit(0); }, MIN * 60_000);
