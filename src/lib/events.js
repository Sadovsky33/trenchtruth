// Decodes pump.fun events (CreateEvent, TradeEvent, CompleteEvent) from transaction logs.
// Layouts and discriminators come from the program IDL (lib/pump_fun_idl.json), vendored from
// pump-fun/pump-public-docs via chainstacklabs/pumpfun-bonkfun-bot. If pump.fun upgrades the
// program, drop a newer IDL file in place; nothing else needs to change.
import fs from 'node:fs';
import { BorshReader } from './borsh.js';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEFAULT_PUBKEY = '11111111111111111111111111111111';

const idl = JSON.parse(fs.readFileSync(new URL('./pump_fun_idl.json', import.meta.url), 'utf8'));
export const TYPES = new Map(idl.types.map((t) => [t.name, t]));

const WANTED = {
  CreateEvent: ['name', 'symbol', 'uri', 'mint', 'bonding_curve', 'user', 'creator', 'timestamp',
    'virtual_token_reserves', 'virtual_sol_reserves', 'real_token_reserves'],
  TradeEvent: ['mint', 'sol_amount', 'token_amount', 'is_buy', 'user', 'timestamp',
    'virtual_sol_reserves', 'virtual_token_reserves', 'real_sol_reserves', 'real_token_reserves'],
  CompleteEvent: ['user', 'mint', 'bonding_curve', 'timestamp'],
};

const BY_DISC = new Map();
for (const ev of idl.events) {
  if (!WANTED[ev.name]) continue;
  BY_DISC.set(Buffer.from(ev.discriminator).toString('hex'), ev.name);
}
for (const name of Object.keys(WANTED)) {
  if (![...BY_DISC.values()].includes(name)) throw new Error(`IDL has no ${name}`);
}

export function discriminatorOf(name) {
  const ev = idl.events.find((e) => e.name === name);
  return Uint8Array.from(ev.discriminator);
}

// pump.fun appends new fields at the end of its events, so trailing bytes after the IDL layout
// are harmless as long as the fields before them still line up. For a SOL-quoted trade the quote
// fields near the end of the layout repeat the SOL fields; for a trade quoted in another token
// the SOL fields are zero and the quote reserves hold the curve. A shifted layout would not
// reproduce either pattern. Other events with trailing bytes stay flagged.
function appendedOnly(name, d) {
  if (name !== 'TradeEvent') return false;
  if (isSolQuote(d.quote_mint)) {
    return d.quote_amount === d.sol_amount && d.virtual_quote_reserves === d.virtual_sol_reserves;
  }
  return d.sol_amount === 0 && d.virtual_sol_reserves === 0 && d.real_sol_reserves === 0
    && d.quote_amount > 0 && d.virtual_quote_reserves >= d.real_quote_reserves;
}

// Decodes one "Program data" payload. Returns { name, data, exact, extra } or null. `exact` is
// false when the payload is shorter than the IDL layout, or longer without passing
// appendedOnly(): a sign the program changed. `extra` is the number of trailing bytes.
export function decodeEventPayload(buf) {
  if (buf.length < 8) return null;
  const name = BY_DISC.get(Buffer.from(buf.subarray(0, 8)).toString('hex'));
  if (!name) return null;
  const reader = new BorshReader(buf, 8);
  let value;
  let complete;
  try {
    ({ value, complete } = reader.readStruct(TYPES.get(name).type.fields, TYPES, true));
  } catch {
    return null;
  }
  for (const f of WANTED[name]) if (value[f] === undefined) return null;
  const extra = buf.length - reader.off;
  return { name, data: value, exact: complete && (extra === 0 || appendedOnly(name, value)), extra };
}

// Runtime frame lines: "Program <id> invoke [n]", "Program <id> success", "Program <id> failed: …".
// Anchored on a real program id so text inside "Program log: …" lines can't fake a frame.
const FRAME = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (invoke \[\d+\]|success$|failed)/;

// Maps every log line to the program whose invocation emitted it. "Program data:" lines do not
// name their program, so without this another program in the same transaction could emit a
// payload that looks like a pump.fun event.
export function emittersOf(logs) {
  const out = new Array(logs.length);
  const stack = [];
  for (let i = 0; i < logs.length; i++) {
    const m = FRAME.exec(logs[i]);
    if (m && m[2].startsWith('invoke')) { stack.push(m[1]); out[i] = null; continue; }
    if (m) { out[i] = null; stack.pop(); continue; }
    out[i] = stack.length ? stack[stack.length - 1] : null;
  }
  return out;
}

// Returns pump.fun events found in a transaction's logs plus quality flags: `truncated` when
// the runtime cut the logs (10 KB limit; later events in that transaction are lost),
// `inexact` for payloads that do not match the IDL layout, and `extended` for exact payloads
// carrying new trailing fields.
export function extractPumpEventsDetailed(logs, programId = PUMP_PROGRAM_ID) {
  const emitters = emittersOf(logs);
  const events = [];
  let truncated = false;
  let inexact = 0;
  let extended = 0;
  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    if (line === 'Log truncated') { truncated = true; continue; }
    if (!line.startsWith('Program data: ')) continue;
    if (emitters[i] !== programId) continue;
    let buf;
    try {
      buf = Buffer.from(line.slice('Program data: '.length).trim(), 'base64');
    } catch {
      continue;
    }
    const ev = decodeEventPayload(buf);
    if (!ev) continue;
    if (!ev.exact) inexact++;
    else if (ev.extra > 0) extended++;
    events.push(ev);
  }
  return { events, truncated, inexact, extended };
}

export function extractPumpEvents(logs, programId = PUMP_PROGRAM_ID) {
  return extractPumpEventsDetailed(logs, programId).events;
}

export function isSolQuote(quoteMint) {
  return quoteMint === undefined || quoteMint === null || quoteMint === DEFAULT_PUBKEY || quoteMint === WSOL_MINT;
}

// Compact records written by the collector (short keys keep files small).
export function toRecord(ev, slot, seq, recvMs, signature) {
  const d = ev.data;
  if (ev.name === 'CreateEvent') {
    return {
      e: 'c', s: slot, q: seq, r: recvMs, sig: signature,
      mint: d.mint, name: d.name, sym: d.symbol, uri: d.uri, user: d.user, creator: d.creator,
      ts: d.timestamp, vT: d.virtual_token_reserves, vS: d.virtual_sol_reserves,
      rT: d.real_token_reserves, mm: d.is_mayhem_mode ?? null, cb: d.is_cashback_enabled ?? null,
      qm: d.quote_mint ?? null, cfb: d.creator_fee_bps ?? null, hr: d.is_holder_reward ?? null,
    };
  }
  if (ev.name === 'TradeEvent') {
    return {
      e: 't', s: slot, q: seq, r: recvMs,
      mint: d.mint, b: d.is_buy ? 1 : 0, sol: d.sol_amount, tok: d.token_amount, u: d.user,
      ts: d.timestamp, vS: d.virtual_sol_reserves, vT: d.virtual_token_reserves,
      rS: d.real_sol_reserves, rT: d.real_token_reserves,
      fb: d.fee_basis_points ?? null, cfb: d.creator_fee_basis_points ?? null,
      cbb: d.cashback_fee_basis_points ?? null, bbb: d.buyback_fee_basis_points ?? null,
      hrb: d.holder_rewards_bps ?? null, qm: d.quote_mint ?? null, qa: d.quote_amount ?? null,
      vQ: d.virtual_quote_reserves ?? null, mm: d.mayhem_mode ?? null, ix: d.ix_name ?? null,
    };
  }
  return { e: 'g', s: slot, q: seq, r: recvMs, mint: d.mint, user: d.user, ts: d.timestamp, qm: d.quote_mint ?? null };
}
