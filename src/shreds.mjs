// Decoding of shred-stream entries (Jito shredstream-proxy "SubscribeEntries": per slot, a
// bincode Vec<Entry>) into transactions, and recognition of pump.fun launches in them. Shreds
// carry transactions before they are executed, so there are no logs or events here: the launch
// is read from the instructions themselves (create / create_v2 and the creator's buy in the
// same transaction).
import fs from 'node:fs';
import path from 'node:path';
import { base58Encode } from './lib/base58.js';

const idl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'lib', 'pump_fun_idl.json'), 'utf8'));
export const PUMP = idl.address;
const disc = (name) => Buffer.from(idl.instructions.find((x) => x.name === name).discriminator).toString('hex');
const D = {
  create: disc('create'), create_v2: disc('create_v2'), buy: disc('buy'), buy_exact_sol_in: disc('buy_exact_sol_in'),
  buy_v2: disc('buy_v2'), buy_exact_quote_in_v2: disc('buy_exact_quote_in_v2'),
};

// Every read is bounds-checked: a wrong layout must throw, not walk past the end reading zeros.
class Cursor {
  constructor(buf) { this.b = buf; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new RangeError(`odczyt poza końcem (${this.o}+${n} > ${this.b.length})`); }
  u8() { this.need(1); return this.b[this.o++]; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  // Solana "short_vec" length (compact-u16).
  len() { let v = 0, s = 0; for (;;) { const x = this.u8(); v |= (x & 0x7f) << s; if (!(x & 0x80)) return v; s += 7; } }
}

// Transaction v1 (SIMD-0385, on mainnet since 2026-09): version byte 0x81 first, legacy header,
// u32 config mask, 32-byte lifetime, u8 instruction count, u8 address count, addresses, 4 bytes
// per set config bit, 4-byte instruction headers (program index u8, account count u8, data
// length u16), the instructions' account indexes and data, then the signatures (no count).
function readTxV1(c) {
  c.u8();
  const header = [c.u8(), c.u8(), c.u8()];
  c.need(4); const mask = c.b.readUInt32LE(c.o); c.o += 4;
  c.bytes(32);
  const nIx = c.u8(), nKeys = c.u8();
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(c.bytes(32));
  let bits = 0;
  for (let m = mask; m; m >>>= 1) bits += m & 1;
  c.bytes(4 * bits);
  const heads = [];
  for (let i = 0; i < nIx; i++) { const programIdIndex = c.u8(), nAcc = c.u8(); c.need(2); const nData = c.b.readUInt16LE(c.o); c.o += 2; heads.push({ programIdIndex, nAcc, nData }); }
  const ixs = heads.map((h) => ({ programIdIndex: h.programIdIndex, accounts: [...c.bytes(h.nAcc)], data: Buffer.from(c.bytes(h.nData)) }));
  const sigs = [];
  for (let i = 0; i < header[0]; i++) sigs.push(c.bytes(64));
  return { sigs, header, keys, ixs };
}

// One transaction in wire format: legacy / v0 (serde short_vec), or v1.
function readTx(c) {
  if (c.b[c.o] === 0x81) return readTxV1(c); // a legacy/v0 transaction would need 129 signatures to start so
  const nSig = c.len();
  const sigs = [];
  for (let i = 0; i < nSig; i++) sigs.push(c.bytes(64));
  let version = 'legacy';
  if (c.b[c.o] & 0x80) { version = c.u8() & 0x7f; }
  const header = [c.u8(), c.u8(), c.u8()];
  const nKeys = c.len();
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(c.bytes(32));
  c.bytes(32); // recent blockhash
  const nIx = c.len();
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = c.u8();
    const nAcc = c.len();
    const accounts = [...c.bytes(nAcc)];
    const nData = c.len();
    ixs.push({ programIdIndex, accounts, data: Buffer.from(c.bytes(nData)) });
  }
  if (version !== 'legacy') {
    const nL = c.len();
    for (let i = 0; i < nL; i++) { c.bytes(32); c.bytes(c.len()); c.bytes(c.len()); }
  }
  return { sigs, header, keys, ixs };
}

// bincode Vec<Entry>; Entry = { num_hashes: u64, hash: [u8; 32], transactions: Vec<VersionedTransaction> }.
export function parseEntries(buf) {
  const c = new Cursor(Buffer.from(buf));
  const n = Number(c.u64());
  const txs = [];
  for (let e = 0; e < n; e++) {
    c.u64(); c.bytes(32);
    const nt = Number(c.u64());
    for (let i = 0; i < nt; i++) txs.push(readTx(c));
  }
  return txs;
}

function readString(b, o) { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n]; }

// pump.fun launch in a decoded transaction, or null. Keys referenced by these instructions are all
// static (the mint and the creator sign), so no address lookup tables are needed.
// The creator's buys in the same transaction are replayed on the launch curve (30 SOL / 1.073e15
// tokens virtual, 1.25% fee) to get the curve state right after them: devSol = SOL they put in,
// vS / vT = virtual reserves our buy will start from (if nobody else buys first).
// solQuote is false when the creator's v2 buy names a quote mint other than SOL (pump.fun also
// runs curves quoted in other tokens; a SOL buy on those fails with UnsupportedQuoteMint) or one
// we cannot read (loaded from a lookup table).
// creatorVault: the creator_vault account of the creator's own buy (coins with holder rewards
// store a creator other than the create argument, so the vault cannot be derived from it);
// tokenProgram: the token program named by the create instruction (null if not a static key).
const V_SOL0 = 30e9, V_TOK0 = 1.073e15, FEE = 0.0125;
const WSOL = 'So11111111111111111111111111111111111111112';
export function pumpLaunch(tx) {
  const key = (i) => (i < tx.keys.length ? base58Encode(tx.keys[i]) : null);
  let launch = null, vS = V_SOL0, vT = V_TOK0, solQuote = true, creatorVault = null;
  for (const ix of tx.ixs) {
    if (key(ix.programIdIndex) !== PUMP || ix.data.length < 8) continue;
    const d = ix.data.subarray(0, 8).toString('hex');
    if ((d === D.buy_v2 || d === D.buy_exact_quote_in_v2) && key(ix.accounts[2]) !== WSOL) solQuote = false;
    if (d === D.buy || d === D.buy_exact_sol_in) creatorVault = key(ix.accounts[9]);
    if (d === D.buy_v2 || d === D.buy_exact_quote_in_v2) creatorVault = key(ix.accounts[16]);
    if (d === D.create || d === D.create_v2) {
      let o = 8, name, symbol, uri;
      [name, o] = readString(ix.data, o); [symbol, o] = readString(ix.data, o); [uri, o] = readString(ix.data, o);
      const creator = base58Encode(ix.data.subarray(o, o + 32)); o += 32;
      const mayhem = d === D.create_v2 ? ix.data[o] === 1 : false;
      const tokenProgram = key(ix.accounts[d === D.create_v2 ? 7 : 9]);
      launch = { sig: base58Encode(tx.sigs[0]), mint: key(ix.accounts[0]), user: key(0), creator, tokenProgram, name, symbol, uri, mayhem, v2: d === D.create_v2 };
    } else if (d === D.buy || d === D.buy_v2) {
      // Exact token amount; max_sol_cost (often u64::MAX) only caps the price.
      const amount = Number(ix.data.readBigUInt64LE(8));
      if (amount >= vT) continue;
      const cost = (vS * amount) / (vT - amount);
      vS += cost; vT -= amount;
    } else if (d === D.buy_exact_sol_in || d === D.buy_exact_quote_in_v2) {
      const net = Number(ix.data.readBigUInt64LE(8)) / (1 + FEE);
      const tokens = (vT * net) / (vS + net);
      vS += net; vT -= tokens;
    }
  }
  return launch ? { ...launch, solQuote, creatorVault, devSol: (vS - V_SOL0) / 1e9, vS, vT } : null;
}
