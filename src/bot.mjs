// TrenchTruth Telegram bot: paste a pump.fun coin address (in a chat or a group the bot is in) and get
// its risk card and a "what if you had bought" simulation, in Polish or English (from the user's
// Telegram language). Plain Bot API over HTTPS, long polling, no dependencies.
// Token: BOT_TOKEN env or bot-token.txt in the repo root. Optional referral link: AXIOM_REF env or
// axiom-ref.txt. Run: node src/bot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { scanMint } from './scan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = (process.env.BOT_TOKEN || fs.readFileSync(path.join(ROOT, 'bot-token.txt'), 'utf8')).trim(); // never committed
const REF_FILE = path.join(ROOT, 'axiom-ref.txt');
const AXIOM_REF = (process.env.AXIOM_REF || (fs.existsSync(REF_FILE) ? fs.readFileSync(REF_FILE, 'utf8') : '')).trim();
const API = `https://api.telegram.org/bot${TOKEN}`;
const tg = async (method, body) => {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}%`;

const T = {
  pl: {
    scanning: 'Sprawdzam monetę… (ok. 15–30 s)',
    verdict: { high: '🔴 Wysokie ryzyko', medium: '🟠 Średnie ryzyko', low: '🟢 Brak wyraźnych sygnałów oszustwa' },
    devBuy: (s) => `Twórca kupił na starcie: ${s} SOL`,
    sim: (d, r, why) => `Gdybyś kupił ${d} s po starcie (0,5 SOL, sprzedaż przy +50% / −20% albo po 5 min): <b>${r}</b> (${why})`,
    why: { zysk: 'cel zysku', strata: 'limit straty', czas: 'po 5 min' },
    none: 'Brak wyraźnych sygnałów ryzyka w danych z pierwszych minut.',
    buy: 'Kup na Axiom (−10% opłat)',
    foot: 'Informacja, nie porada inwestycyjna. Link do Axiom jest linkiem polecającym.',
    notFound: 'Nie znalazłem tej monety na pump.fun.',
    err: 'Coś poszło nie tak przy sprawdzaniu. Spróbuj za chwilę.',
    hello: 'Wklej adres monety z pump.fun, a powiem Ci, czy wygląda na oszustwo i co by było, gdybyś ją kupił.',
  },
  en: {
    scanning: 'Checking the coin… (about 15–30 s)',
    verdict: { high: '🔴 High risk', medium: '🟠 Medium risk', low: '🟢 No clear scam signals' },
    devBuy: (s) => `Creator bought at launch: ${s} SOL`,
    sim: (d, r, why) => `If you had bought ${d} s after launch (0.5 SOL, sell at +50% / −20% or after 5 min): <b>${r}</b> (${why})`,
    why: { zysk: 'take profit', strata: 'stop loss', czas: 'after 5 min' },
    none: 'No clear risk signals in the first minutes of data.',
    buy: 'Buy on Axiom (−10% fees)',
    foot: 'Information, not financial advice. The Axiom link is a referral link.',
    notFound: 'I could not find this coin on pump.fun.',
    err: 'Something went wrong while checking. Try again in a moment.',
    hello: 'Paste a pump.fun coin address and I will tell you if it looks like a scam and what would have happened if you had bought it.',
  },
};

function card(r, L) {
  const t = T[L];
  if (r.error) return { text: t.notFound };
  const lines = [
    `<b>${esc(r.symbol)}</b> · ${esc(r.name)}`,
    `<code>${r.mint}</code>`,
    '',
    `<b>${t.verdict[r.verdict]}</b>`,
    ...(r.signals.length ? r.signals.map((s) => `${s.level === 'good' ? '✅' : s.level === 'info' ? 'ℹ️' : '⚠️'} ${esc(s[L])}`) : [t.none]),
    t.devBuy(r.devBuySol.toFixed(2)),
    '',
    ...r.sims.map((s) => t.sim(s.delaySec, pct(s.ret), t.why[s.reason])),
    '',
    `<i>${esc(r.note[L])}</i>`,
    `<i>${t.foot}</i>`,
  ];
  const kb = AXIOM_REF ? { inline_keyboard: [[{ text: t.buy, url: `${AXIOM_REF}${AXIOM_REF.includes('?') ? '&' : '?'}chain=sol&address=${r.mint}` }]] } : undefined;
  return { text: lines.join('\n'), reply_markup: kb };
}

const busy = new Set();
async function handle(msg) {
  const text = msg.text || msg.caption || '';
  const L = (msg.from?.language_code || '').startsWith('pl') ? 'pl' : 'en';
  if (/^\/start/.test(text)) return tg('sendMessage', { chat_id: msg.chat.id, text: T[L].hello });
  const m = text.match(ADDR);
  if (!m) return;
  const key = `${msg.chat.id}:${m[0]}`;
  if (busy.has(key)) return;
  busy.add(key);
  const wait = await tg('sendMessage', { chat_id: msg.chat.id, text: T[L].scanning, reply_to_message_id: msg.message_id });
  try {
    const r = await scanMint(m[0]);
    const c = card(r, L);
    await tg('editMessageText', { chat_id: msg.chat.id, message_id: wait.result.message_id, text: c.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: c.reply_markup });
  } catch (e) {
    console.error(new Date().toISOString(), 'błąd', String(e).slice(0, 200));
    await tg('editMessageText', { chat_id: msg.chat.id, message_id: wait.result.message_id, text: T[L].err });
  } finally { busy.delete(key); }
}

let offset = 0;
const me = await tg('getMe', {});
console.log(`Bot @${me.result?.username} działa.`);
for (;;) {
  try {
    const u = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const up of u.result || []) {
      offset = up.update_id + 1;
      if (up.message) handle(up.message).catch(() => {});
    }
  } catch { await new Promise((r) => setTimeout(r, 2000)); }
}
