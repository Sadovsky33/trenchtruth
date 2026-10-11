// TrenchTruth — risk card and "what if you had bought" simulator for a pump.fun coin.
// scanMint(mint) reads the coin's launch and first minutes from the chain (Helius RPC, Jito's public
// bundle API) and combines them with our launch history (db/launches.jsonl: past launches with
// creator wallet, its funder and whether the coin was dead 5 minutes after launch).
// CLI: node src/scan.mjs <mint>
import fs from 'node:fs';
import path from 'node:path';
import { extractPumpEvents, isSolQuote } from './lib/events.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = process.env.HELIUS_KEY || fs.readFileSync(path.join(ROOT, 'helius-key.txt'), 'utf8').trim(); // never committed (.gitignore)
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await sleep(600 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (method === 'getTransaction') return null; throw new Error(j.error.message); }
      return j.result;
    } catch (e) { if (i === 9) throw e; await sleep(500); }
  }
}
async function jito(p) {
  try {
    const r = await fetch(`https://bundles.jito.wtf/api/v1/bundles/${p}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j[0] ?? null : j;
  } catch { return null; }
}

// --- launch history ------------------------------------------------------------------------
const DB = process.env.TT_DB || path.join(ROOT, 'data', 'launches.jsonl');
const hist = { byWallet: new Map(), byFunder: new Map(), funderOf: new Map(), funderWallets: new Map(), proSnipers: new Set() };
function loadDb() {
  if (!fs.existsSync(DB)) return;
  for (const l of fs.readFileSync(DB, 'utf8').split('\n')) {
    if (!l) continue;
    const x = JSON.parse(l);
    if (x.pro) { hist.proSnipers.add(x.pro); continue; }
    const add = (m, k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(x); };
    add(hist.byWallet, x.w);
    if (x.funder) {
      add(hist.byFunder, x.funder);
      hist.funderOf.set(x.w, x.funder);
      if (!hist.funderWallets.has(x.funder)) hist.funderWallets.set(x.funder, new Set());
      hist.funderWallets.get(x.funder).add(x.w);
    }
  }
}
loadDb();

// Who sent a wallet its first SOL (its oldest transaction).
async function funderOf(w) {
  if (hist.funderOf.has(w)) return hist.funderOf.get(w);
  let before, oldest = null;
  for (let p = 0; p < 3; p++) {
    const page = await rpc('getSignaturesForAddress', [w, { limit: 1000, before }]);
    if (!page?.length) break;
    oldest = page[page.length - 1];
    if (page.length < 1000) break;
    before = oldest.signature;
    if (p === 2) return null; // a busy wallet, not a fresh launch wallet
  }
  if (!oldest) return null;
  const tx = await rpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
  if (!tx) return null;
  for (const ix of [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions)]) {
    const info = ix.parsed?.info;
    if (ix.program === 'system' && info && (info.destination ?? info.newAccount) === w) return info.source ?? info.fundingAccount ?? null;
  }
  const payer = tx.transaction.message.accountKeys[0]?.pubkey;
  return payer && payer !== w ? payer : null;
}

// --- the coin's first minutes -----------------------------------------------------------------
// A coin's create event and its trades in the first `minutes`, oldest first. Fast path: Helius
// getTransactionsForAddress returns full transactions in ascending order, 100 per call, so even a coin with
// tens of thousands of transactions needs a few calls. Falls back to signatures + getTransaction.
async function launchData(mint, minutes = 5) {
  try {
    const fast = await launchDataFast(mint, minutes);
    if (fast) return fast;
  } catch (e) { console.error(new Date().toISOString(), 'fast path failed, falling back', String(e).slice(0, 120)); }
  return launchDataSlow(mint, minutes);
}

async function launchDataFast(mint, minutes) {
  const span = Math.round((minutes * 60) / 0.4);
  const trades = [];
  let ce = null, firstSlot = null, total = 0, paginationToken;
  for (let p = 0; p < 10; p++) {
    const res = await rpc('getTransactionsForAddress', [mint, { transactionDetails: 'full', sortOrder: 'asc', limit: 100, encoding: 'json', maxSupportedTransactionVersion: 1, ...(paginationToken ? { paginationToken } : {}) }]);
    const data = res?.data || [];
    let done = false;
    for (const tx of data) {
      total++;
      if (!tx?.meta || tx.meta.err) continue;
      if (firstSlot === null) firstSlot = tx.slot;
      if (tx.slot > firstSlot + span) { done = true; break; }
      const sig = tx.transaction?.signatures?.[0];
      for (const e of extractPumpEvents(tx.meta.logMessages || [])) {
        if (e.name === 'CreateEvent' && e.data.mint === mint) ce = { ...e.data, sig, slot: tx.slot, bt: tx.blockTime };
        if (e.name === 'TradeEvent' && e.data.mint === mint) trades.push({ sig, slot: tx.slot, bt: tx.blockTime, buy: e.data.is_buy, sol: Number(e.data.sol_amount), tok: Number(e.data.token_amount), u: e.data.user, vS: Number(e.data.virtual_sol_reserves), vT: Number(e.data.virtual_token_reserves) });
      }
    }
    paginationToken = res?.paginationToken;
    if (done || !paginationToken || !data.length) break;
  }
  return ce ? { ce, trades, totalSigs: total } : null;
}

async function launchDataSlow(mint, minutes = 5) {
  let sigs = [], before, reachedStart = false;
  for (let p = 0; p < 6; p++) {
    const page = await rpc('getSignaturesForAddress', [mint, { limit: 1000, before }]);
    if (!page?.length) { reachedStart = true; break; }
    sigs.push(...page);
    if (page.length < 1000) { reachedStart = true; break; }
    before = page[page.length - 1].signature;
  }
  // Popular coins have more history than we walk back through; ask Helius for the oldest signatures instead.
  sigs = reachedStart ? sigs.reverse() : await oldestSigs(mint, minutes); // oldest first
  const create = sigs.find((s) => !s.err);
  if (!create) return null;
  // Busy launches can have thousands of trades in the first minutes; the first 600 cover what we score.
  const window = sigs.filter((s) => !s.err && s.slot <= create.slot + Math.round((minutes * 60) / 0.4)).slice(0, 600);
  const trades = [];
  let ce = null;
  for (let i = 0; i < window.length; i += 8) {
    const batch = await Promise.all(window.slice(i, i + 8).map((s) => rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }])));
    batch.forEach((tx, j) => {
      if (!tx) return;
      for (const e of extractPumpEvents(tx.meta.logMessages || [])) {
        if (e.name === 'CreateEvent' && e.data.mint === mint) ce = { ...e.data, sig: window[i + j].signature, slot: tx.slot, bt: tx.blockTime };
        if (e.name === 'TradeEvent' && e.data.mint === mint) trades.push({ sig: window[i + j].signature, slot: tx.slot, bt: tx.blockTime, buy: e.data.is_buy, sol: Number(e.data.sol_amount), tok: Number(e.data.token_amount), u: e.data.user, vS: Number(e.data.virtual_sol_reserves), vT: Number(e.data.virtual_token_reserves) });
      }
    });
  }
  return ce ? { ce, trades, totalSigs: sigs.length } : null;
}

// Oldest signatures of an address, ascending, up to `minutes` after the first one (Helius getTransactionsForAddress).
async function oldestSigs(address, minutes) {
  const out = [];
  let paginationToken;
  for (let p = 0; p < 5; p++) {
    const res = await rpc('getTransactionsForAddress', [address, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 1000, ...(paginationToken ? { paginationToken } : {}) }]);
    const data = res?.data || [];
    out.push(...data);
    paginationToken = res?.paginationToken;
    const first = out.find((s) => !s.err);
    if (!data.length || !paginationToken || (first && out.at(-1).slot > first.slot + Math.round((minutes * 60) / 0.4))) break;
  }
  return out;
}

// Value of `tokens` sold into a curve state, after the 1.25% fee (constant product).
// Polish plural of "moneta" after a number (2–4 → monety, otherwise monet; 12–14 → monet).
const monet = (n) => (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'monety' : 'monet');
const sellValue = (vS, vT, tokens) => ((tokens * vS) / (vT + tokens)) * (1 - 0.0125);

// Where did the bundle wallets' coins go? For each bundle wallet (and one hop further for wallets it moved coins
// to), read its transactions since the launch and split every outflow of this mint into "sold" (the transaction
// went through a trading program) or "moved" (plain transfer to another wallet). Amounts are base units.
const TRADING_PROGRAMS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
]);
async function txsSince(address, slot) {
  const res = await rpc('getTransactionsForAddress', [address, { transactionDetails: 'full', sortOrder: 'asc', limit: 100, encoding: 'json', maxSupportedTransactionVersion: 1, filters: { slot: { gte: slot } } }]);
  return res?.data || [];
}
function flows(tx, mint, wallet) {
  const d = {};
  for (const b of tx.meta?.preTokenBalances || []) if (b.mint === mint) d[b.owner] = (d[b.owner] || 0) - Number(b.uiTokenAmount.amount);
  for (const b of tx.meta?.postTokenBalances || []) if (b.mint === mint) d[b.owner] = (d[b.owner] || 0) + Number(b.uiTokenAmount.amount);
  const out = -(d[wallet] || 0);
  if (out <= 0 || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const invoked = new Set((tx.transaction?.message?.instructions || []).map((ix) => keys[ix.programIdIndex]));
  for (const inner of tx.meta?.innerInstructions || []) for (const ix of inner.instructions) invoked.add(keys[ix.programIdIndex]);
  const traded = [...invoked].some((p) => TRADING_PROGRAMS.has(p));
  const to = Object.entries(d).filter(([o, v]) => v > 0 && o !== wallet).map(([o, v]) => [o, v]);
  return { out, traded, to };
}
async function traceBundle(mint, slot, wallets) {
  let sold = 0, moved = 0, soldAfterMove = 0;
  const hops = new Map(); // recipient -> amount received from the bundle wallets
  for (const w of wallets.slice(0, 6)) {
    for (const tx of await txsSince(w, slot)) {
      const f = flows(tx, mint, w);
      if (!f) continue;
      if (f.traded) sold += f.out;
      else { moved += f.out; for (const [o, v] of f.to) if (!wallets.includes(o)) hops.set(o, (hops.get(o) || 0) + v); }
    }
  }
  // One hop further for the largest recipients.
  const top = [...hops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [h] of top) for (const tx of await txsSince(h, slot)) { const f = flows(tx, mint, h); if (f?.traded) soldAfterMove += f.out; }
  return { sold, moved, soldAfterMove, recipients: hops.size };
}

// "What if you had bought `size` SOL `delaySec` after launch and sold at +tp / −sl / after holdSec?"
export function simulate(data, { delaySec = 3, size = 0.5, tp = 0.5, sl = 0.2, holdSec = 300 } = {}) {
  const { ce, trades } = data;
  const entrySlot = ce.slot + Math.round(delaySec / 0.4);
  let i0 = -1;
  for (let i = 0; i < trades.length; i++) { if (trades[i].slot <= entrySlot) i0 = i; else break; }
  const st = i0 >= 0 ? trades[i0] : { vS: Number(ce.virtual_sol_reserves), vT: Number(ce.virtual_token_reserves) };
  const solIn = (size * 1e9) / 1.0125;
  const tokens = (solIn * st.vT) / (st.vS + solIn);
  const cost = size * 1e9;
  let exit = null, reason = 'czas';
  for (let j = i0 + 1; j < trades.length; j++) {
    const t = trades[j];
    if (t.slot > entrySlot + holdSec / 0.4) break;
    // later states already include everyone's trades; ours is added on top (it raised the price).
    const v = sellValue(t.vS + solIn, (t.vS * t.vT) / (t.vS + solIn), tokens);
    const r = v / cost - 1;
    if (r >= tp) { exit = j; reason = 'zysk'; break; }
    if (r <= -sl) { exit = j; reason = 'strata'; break; }
  }
  // Executed one slot after the trigger (reaction), at the state then.
  const execSlot = exit === null ? entrySlot + holdSec / 0.4 : trades[exit].slot + 1;
  let k = i0;
  for (let j = Math.max(0, i0 + 1); j < trades.length && trades[j].slot <= execSlot; j++) k = j;
  const fin = k >= 0 ? trades[k] : st;
  const value = sellValue(fin.vS + solIn, (fin.vS * fin.vT) / (fin.vS + solIn), tokens);
  return { delaySec, entryPriceVsLaunch: (st.vS / st.vT) / (Number(ce.virtual_sol_reserves) / Number(ce.virtual_token_reserves)) - 1, ret: value / cost - 1, reason, othersBeforeSol: (st.vS - Number(ce.virtual_sol_reserves)) / 1e9 };
}

export async function scanMint(mint) {
  const data = await launchData(mint);
  if (!data) return { mint, error: 'Nie znaleziono utworzenia monety na pump.fun.' };
  const { ce, trades } = data;
  const creator = ce.user;
  // Coins quoted in another token (e.g. a tokenized stock) report 0 SOL in trades: skip every SOL-based check.
  const solQuote = isSolQuote(ce.quote_mint);
  const isDev = (t) => t.u === creator || t.u === ce.creator;
  const devBuys = trades.filter((t) => t.slot === ce.slot && t.buy && isDev(t));
  const sameSlot = trades.filter((t) => t.slot === ce.slot && t.buy && !isDev(t));
  const devSold = trades.find((t) => !t.buy && isDev(t));
  // Creator's own Jito bundle: buys landing atomically with the create.
  const cb = await jito(`transaction/${ce.sig}`);
  const bundle = cb ? await jito(`bundle/${cb.bundle_id}`) : null;
  const bundleSigs = new Set(bundle?.txSignatures || []);
  const bundleBuys = trades.filter((t) => bundleSigs.has(t.sig) && t.buy && !isDev(t));
  const funder = await funderOf(creator);
  const walletHist = (hist.byWallet.get(creator) || []).filter((x) => x.mint !== mint);
  const funderHist = funder ? (hist.byFunder.get(funder) || []).filter((x) => x.w !== creator) : [];
  const funderSize = funder ? (hist.funderWallets.get(funder)?.size ?? 0) : 0;
  const last = trades[trades.length - 1];
  const real5 = ((last ? last.vS : Number(ce.virtual_sol_reserves)) - Number(ce.virtual_sol_reserves)) / 1e9;
  const deadRate = (a) => (a.length ? a.filter((x) => x.dead).length / a.length : null);
  const signals = [];
  const S = (level, pl, en) => signals.push({ level, pl, en });
  if (walletHist.length >= 2 && deadRate(walletHist) >= 0.8) S('high', `Twórca wypuścił już ${walletHist.length} ${monet(walletHist.length)}, ${Math.round(100 * deadRate(walletHist))}% padło w 5 minut`, `Creator launched ${walletHist.length} coins before, ${Math.round(100 * deadRate(walletHist))}% died within 5 minutes`);
  if (walletHist.length >= 2 && deadRate(walletHist) < 0.5) S('good', `Twórca ma dobrą historię: ${walletHist.length} ${monet(walletHist.length)}, tylko ${Math.round(100 * deadRate(walletHist))}% padło szybko`, `Creator has a good record: ${walletHist.length} coins, only ${Math.round(100 * deadRate(walletHist))}% died fast`);
  if (funderHist.length >= 2 && deadRate(funderHist) >= 0.8) S('high', `Nowy portfel, ale zasilił go portfel, który finansował ${funderSize} innych twórców: ${funderHist.length} ${monet(funderHist.length)}, ${Math.round(100 * deadRate(funderHist))}% padło w 5 minut`, `Fresh wallet, but funded by a wallet that funded ${funderSize} other creators: ${funderHist.length} coins, ${Math.round(100 * deadRate(funderHist))}% died within 5 minutes`);
  if (funderSize >= 50 && !(funderHist.length >= 2 && deadRate(funderHist) >= 0.8)) S('info', 'Portfel twórcy zasilony z giełdy lub dużej usługi (trudno go powiązać)', 'Creator wallet funded from an exchange or a large service (hard to link)');
  // Share of the 1B supply (1e15 base units) taken by the wallets bundled with the launch.
  let bundleShare = 0;
  if (bundleBuys.length) {
    const nb = new Set(bundleBuys.map((t) => t.u)).size;
    const sol = bundleBuys.reduce((a, t) => a + t.sol, 0) / 1e9;
    bundleShare = bundleBuys.reduce((a, t) => a + t.tok, 0) / 1e15;
    const amt = solQuote && sol >= 0.01 ? ` (${sol.toFixed(2)} SOL)` : ''; // dust-sized bundle buys: no amount, "0.00 SOL" reads like a bug
    const share = bundleShare >= 0.01 ? Math.round(100 * bundleShare) : 0;
    S('high', `Twórca kupił razem z ${nb} ${nb === 1 ? 'innym portfelem' : 'innymi portfelami'} w jednej paczce z utworzeniem${amt}${share ? `: wzięły ok. ${share}% wszystkich monet` : ''}`,
      `Creator bought together with ${nb} other wallet${nb === 1 ? '' : 's'} in the same bundle as the launch${amt}${share ? `, taking about ${share}% of the supply` : ''}`);
    // Follow the bundle's coins: sold, moved to other wallets, or still held. Best effort: on any error the card
    // simply goes without these lines.
    if (bundleShare >= 0.05) {
      try {
        const tr = await traceBundle(mint, ce.slot, [...new Set(bundleBuys.map((t) => t.u))]);
        const pct = (x) => Math.round((100 * x) / 1e15);
        const soldAll = tr.sold + Math.min(tr.soldAfterMove, tr.moved); // a hop wallet may also sell coins it bought itself
        const others = (n) => (n === 1 ? 'inny portfel' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'inne portfele' : 'innych portfeli');
        if (pct(tr.moved) >= 1) S('warn', `Portfele z paczki przerzuciły ok. ${pct(tr.moved)}% podaży na ${tr.recipients} ${others(tr.recipients)}`, `Bundle wallets moved about ${pct(tr.moved)}% of the supply to ${tr.recipients} other wallet${tr.recipients === 1 ? '' : 's'}`);
        if (pct(soldAll) >= 1) S(pct(soldAll) >= 10 ? 'high' : 'warn', `Insiderzy z paczki już sprzedali ok. ${pct(soldAll)}% podaży${tr.soldAfterMove > 0 ? ' (część przez portfele, na które przerzucili monety)' : ''}`, `Bundle insiders have already sold about ${pct(soldAll)}% of the supply${tr.soldAfterMove > 0 ? ' (partly through the wallets they moved coins to)' : ''}`);
        if (pct(tr.moved) < 1 && pct(soldAll) < 1) S('warn', 'Portfele z paczki wciąż trzymają swoje monety: mogą je sprzedać w każdej chwili', 'Bundle wallets still hold their coins and can sell them at any moment');
      } catch (e) { console.error(new Date().toISOString(), 'bundle trace failed', String(e).slice(0, 120)); }
    }
  }
  const pros = sameSlot.filter((t) => hist.proSnipers.has(t.u));
  if (sameSlot.length >= 5) S('warn', `${sameSlot.length} zakupów w pierwszym bloku${pros.length ? `, w tym ${pros.length} ${pros.length === 1 ? 'zawodowego bota' : 'zawodowych botów'}` : ''}: wejdziesz po nich`, `${sameSlot.length} buys in the very first block${pros.length ? `, ${pros.length} by ${pros.length === 1 ? 'a professional bot' : 'professional bots'}` : ''}: you would buy after them`);
  if (devSold) S('high', `Twórca już sprzedawał (po ${Math.max(0, devSold.bt - ce.bt)} s)`, `Creator already sold (after ${Math.max(0, devSold.bt - ce.bt)} s)`);
  const ageSec = Date.now() / 1000 - ce.bt;
  // No record of the creator or its funder: say so instead of implying the coin is clean.
  // No usable history for the creator or its funder (an exchange-funded wallet included): we cannot judge it.
  const noHistory = walletHist.length < 2 && funderHist.length < 2;
  const noRecord = noHistory && funderSize < 50;
  if (noRecord) S('info', 'Ani twórcy, ani portfela, który go zasilił, nie ma w naszej bazie (15 tys. startów z 6–7 października). Brak danych nie znaczy, że jest bezpiecznie', 'Neither the creator nor its funder is in our database (15k launches from Oct 6–7). No data does not mean safe');
  if (ce.is_mayhem_mode) S('info', 'Moneta w trybie Mayhem: przez pierwsze 24 h handluje nią agent AI pump.fun, który może mocno ruszać ceną', 'Mayhem Mode coin: for its first 24 h a pump.fun AI agent trades it and can move the price sharply');
  if (!solQuote) S('info', 'Ta moneta jest wyceniana w innym tokenie niż SOL (np. tokenizowanej akcji), więc pomijam kwoty w SOL i symulację', 'This coin is priced in a token other than SOL (e.g. a tokenized stock), so SOL amounts and the simulator are skipped');
  // A coin under a minute old has had no time to attract buyers, so a near-empty curve is not "dead" yet.
  if (solQuote && real5 < 0.3 && ageSec >= 60) S('high', ageSec > 300 ? 'Moneta padła w pierwszych 5 minutach: w krzywej nie zostało prawie żadnego SOL' : 'Moneta jest martwa: w krzywej prawie nie ma już SOL', ageSec > 300 ? 'Coin died within its first 5 minutes: almost no SOL left in the curve' : 'Coin is dead: almost no SOL left in the curve');
  const highs = signals.filter((s) => s.level === 'high').length;
  // Insiders taking a fifth of the supply in the launch bundle is high risk on its own.
  const verdict = highs >= 2 || bundleShare >= 0.2 ? 'high' : highs === 1 || signals.some((s) => s.level === 'warn') ? 'medium' : noHistory ? 'unknown' : 'low';
  // A simulation is final only once the entry delay plus the 5-minute hold has passed.
  const sim = (delaySec) => ({ ...simulate(data, { delaySec }), tooEarly: ageSec < delaySec, pending: ageSec < delaySec + 300 });
  return {
    mint, name: ce.name, symbol: ce.symbol, launchedAt: ce.bt, ageSec: Math.round(ageSec), creator, funder,
    devBuySol: solQuote ? devBuys.reduce((a, t) => a + t.sol, 0) / 1e9 : null, quoteMint: solQuote ? null : ce.quote_mint, firstBlockBuys: sameSlot.length,
    signals, verdict, solInCurve: solQuote ? real5 : null,
    sims: solQuote ? [sim(3), sim(30)] : [],
    note: { pl: '82% nowych monet pada w ciągu 5 minut (nasze dane: 15 tys. monet).', en: '82% of new coins die within 5 minutes (our data: 15k coins).' },
  };
}

if (process.argv[1] && process.argv[1].endsWith('scan.mjs')) {
  const mint = process.argv[2];
  if (!mint) { console.log('Usage: node src/scan.mjs <mint>'); process.exit(1); }
  const r = await scanMint(mint);
  console.log(JSON.stringify(r, null, 2));
}
