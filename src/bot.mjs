// TrenchTruth Telegram bot: paste a pump.fun coin address (in a chat or a group the bot is in) and get
// its risk card and a "what if you had bought" simulation, in Polish or English (from the user's
// Telegram language). Plain Bot API over HTTPS, long polling, no dependencies.
// Token: BOT_TOKEN env or bot-token.txt in the repo root. Optional referral link: AXIOM_REF env or
// axiom-ref.txt. Run: node src/bot.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanMint } from './scan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = (process.env.BOT_TOKEN || fs.readFileSync(path.join(ROOT, 'bot-token.txt'), 'utf8')).trim(); // never committed
const REF_FILE = path.join(ROOT, 'axiom-ref.txt');
const AXIOM_REF = (process.env.AXIOM_REF || (fs.existsSync(REF_FILE) ? fs.readFileSync(REF_FILE, 'utf8') : '')).trim();
const API = `https://api.telegram.org/bot${TOKEN}`;
// Anonymous usage log (logs/usage.jsonl): time, a salted hash of the chat id, chat type, verdict. No names,
// usernames or message text, so it only counts checks and distinct chats.
const LOG_DIR = path.join(ROOT, 'logs');
const SALT = crypto.createHash('sha256').update(TOKEN).digest('hex');
function logUse(msg, verdict) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const chat = crypto.createHash('sha256').update(SALT + msg.chat.id).digest('hex').slice(0, 12);
    fs.appendFileSync(path.join(LOG_DIR, 'usage.jsonl'), JSON.stringify({ t: Date.now(), chat, type: msg.chat.type, verdict }) + '\n');
  } catch { /* the log must never break a reply */ }
}
const tg = async (method, body) => {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
// A coin address is a 32–44 character base58 run. Copying a message can glue extra characters onto it
// (e.g. the time "17:37" → "…pump17"), so for longer runs we look for the pump.fun "…pump" ending inside.
function findMint(text) {
  for (const run of text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) || []) {
    if (run.length <= 44) return run;
    const m = run.match(/[1-9A-HJ-NP-Za-km-z]{28,40}pump/);
    if (m) return m[0];
  }
  return null;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}%`;
// Polish uses a decimal comma.
const dec = (s, L) => (L === 'pl' ? String(s).replace(/(\d)\.(\d)/g, '$1,$2') : String(s));

const T = {
  pl: {
    scanning: 'Sprawdzam monetę… (zwykle kilka sekund)',
    verdict: { high: '🔴 Wysokie ryzyko', medium: '🟠 Średnie ryzyko', low: '🟢 Brak sygnałów ryzyka w naszych danych', unknown: '⚪ Za mało danych, żeby ocenić' },
    devBuy: (s) => `Twórca kupił na starcie: ${s} SOL`,
    sim: (d, r, why) => `Gdybyś kupił ${d} s po starcie (0,5 SOL, sprzedaż przy +50% / −20% albo po 5 min): <b>${r}</b> (${why})`,
    simEarly: (d, age) => `Gdybyś kupił ${d} s po starcie: za wcześnie, moneta ma dopiero ${age} s`,
    simNow: (d, r, age) => `Gdybyś kupił ${d} s po starcie (0,5 SOL): na razie <b>${r}</b> (moneta ma ${age} s, wynik końcowy po 5 min)`,
    why: { zysk: 'cel zysku', strata: 'limit straty', czas: 'po 5 min' },
    none: 'Brak wyraźnych sygnałów ryzyka w danych z pierwszych minut.',
    buy: 'Kup na Axiom (−10% opłat)',
    foot: 'Informacja, nie porada inwestycyjna.',
    ref: 'Link do Axiom jest linkiem polecającym.',
    notFound: 'Nie znalazłem tej monety na pump.fun. Jeśli powstała przed chwilą, spróbuj ponownie za kilka sekund.',
    noAddr: 'Nie widzę tu adresu monety. Wklej sam adres z pump.fun (32–44 znaki, zwykle kończy się na „pump”).',
    err: 'Coś poszło nie tak przy sprawdzaniu. Spróbuj za chwilę.',
    hello: 'Wklej adres monety z pump.fun, a powiem Ci, czy wygląda na oszustwo i co by było, gdybyś ją kupił.',
  },
  en: {
    scanning: 'Checking the coin… (usually a few seconds)',
    verdict: { high: '🔴 High risk', medium: '🟠 Medium risk', low: '🟢 No risk signals in our data', unknown: '⚪ Not enough data to judge' },
    devBuy: (s) => `Creator bought at launch: ${s} SOL`,
    sim: (d, r, why) => `If you had bought ${d} s after launch (0.5 SOL, sell at +50% / −20% or after 5 min): <b>${r}</b> (${why})`,
    simEarly: (d, age) => `If you had bought ${d} s after launch: too early, the coin is only ${age} s old`,
    simNow: (d, r, age) => `If you had bought ${d} s after launch (0.5 SOL): so far <b>${r}</b> (coin is ${age} s old, final result after 5 min)`,
    why: { zysk: 'take profit', strata: 'stop loss', czas: 'after 5 min' },
    none: 'No clear risk signals in the first minutes of data.',
    buy: 'Buy on Axiom (−10% fees)',
    foot: 'Information, not financial advice.',
    ref: 'The Axiom link is a referral link.',
    notFound: 'I could not find this coin on pump.fun. If it launched a moment ago, try again in a few seconds.',
    noAddr: 'I cannot see a coin address here. Paste just the pump.fun address (32–44 characters, usually ending in "pump").',
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
    ...(r.signals.length ? r.signals.map((s) => `${s.level === 'good' ? '✅' : s.level === 'info' ? 'ℹ️' : '⚠️'} ${esc(dec(s[L], L))}`) : [t.none]),
    ...(r.devBuySol == null ? [] : [t.devBuy(dec(r.devBuySol.toFixed(2), L))]),
    '',
    ...r.sims.map((s) => (s.tooEarly ? t.simEarly(s.delaySec, r.ageSec) : s.pending && s.reason === 'czas' ? t.simNow(s.delaySec, pct(s.ret), r.ageSec) : t.sim(s.delaySec, pct(s.ret), t.why[s.reason]))),
    '',
    `<i>${esc(r.note[L])}</i>`,
    `<i>${t.foot}${AXIOM_REF ? ' ' + t.ref : ''}</i>`,
  ];
  const kb = AXIOM_REF ? { inline_keyboard: [[{ text: t.buy, url: `${AXIOM_REF}${AXIOM_REF.includes('?') ? '&' : '?'}chain=sol&address=${r.mint}` }]] } : undefined;
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n'), reply_markup: kb };
}

const busy = new Set();
const langOf = new Map(); // chat id -> 'pl' | 'en' chosen with /pl or /en (until the bot restarts)
async function handle(msg) {
  const text = msg.text || msg.caption || '';
  const pick = text.match(/^\/(pl|en)\b/);
  if (pick) {
    langOf.set(msg.chat.id, pick[1]);
    return tg('sendMessage', { chat_id: msg.chat.id, text: pick[1] === 'pl' ? 'Od teraz odpowiadam po polsku.' : 'I will answer in English from now on.' });
  }
  const L = langOf.get(msg.chat.id) || ((msg.from?.language_code || '').startsWith('pl') ? 'pl' : 'en');
  if (/^\/start/.test(text)) return sendMenu(msg.chat.id, L);
  const mint = findMint(text);
  if (!mint) {
    // In a private chat say what went wrong; in groups stay quiet so normal conversation is not interrupted.
    if (msg.chat.type === 'private' && text.trim()) return tg('sendMessage', { chat_id: msg.chat.id, text: T[L].noAddr, reply_to_message_id: msg.message_id });
    return;
  }
  return checkCoin(msg.chat, mint, L, msg.message_id);
}

async function checkCoin(chat, mint, L, replyTo) {
  const key = `${chat.id}:${mint}`;
  if (busy.has(key)) return false;
  busy.add(key);
  const wait = await tg('sendMessage', { chat_id: chat.id, text: T[L].scanning, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
  try {
    let r = await scanMint(mint);
    // A coin launched seconds ago may not be indexed yet: try once more.
    if (r.error) { await new Promise((ok) => setTimeout(ok, 4000)); r = await scanMint(mint); }
    logUse({ chat }, r.error ? 'notfound' : r.verdict);
    const c = card(r, L);
    await tg('editMessageText', { chat_id: chat.id, message_id: wait.result.message_id, text: c.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: c.reply_markup });
  } catch (e) {
    console.error(new Date().toISOString(), 'błąd', String(e).slice(0, 200));
    await tg('editMessageText', { chat_id: chat.id, message_id: wait.result.message_id, text: T[L].err });
  } finally { busy.delete(key); }
}

// Start menu: three real example coins, how it works, the website and the language switch.
const EXAMPLES = ['5EKWMRkatXSgMJ5Zwh38sKKFHeroeUFjVmFFnB6Q5bHg', 'GdDpqx7i7cbskew6cDNqP56ZbHe6aUYZfX3zSknvpump', '6KzQNkCU6tFif4a9ngu6rQ4eJhxxrBbQJYjD9oWpump'];
const SITE = 'https://sadovsky33.github.io/trenchtruth/';
const MENU = {
  pl: { ex: ['🕸 Przykład: siatka oszustów', '📦 Przykład: paczka insiderów (−99%)', '✅ Przykład: dobry twórca'], how: 'ℹ️ Jak to działa', site: '🌐 Strona',
    howText: 'Jak to działa:\n1. Wklejasz adres monety z pump.fun albo link do niej.\n2. Czytam jej historię na Solanie: kto dał twórcy pieniądze i co stało się z innymi monetami, które ten portfel finansował, historię samego twórcy, zakupy w paczce z utworzeniem i zawodowe boty w pierwszym bloku.\n3. Dostajesz kartę z werdyktem i sprawdzeniem rzeczywistości: co naprawdę dostał ktoś, kto kupił 3 albo 30 sekund po starcie.\n\nDodaj mnie do grupy, a każdy będzie mógł wkleić adres. Nigdy nie proszę o klucze ani środki. To nie jest porada inwestycyjna.' },
  en: { ex: ['🕸 Example: rug network', '📦 Example: insider bundle (−99%)', '✅ Example: good creator'], how: 'ℹ️ How it works', site: '🌐 Website',
    howText: 'How it works:\n1. Paste a pump.fun coin address or a pump.fun link.\n2. I read its history on Solana: who funded the creator and what happened to the other coins that wallet funded, the creator\'s own record, buys bundled with the launch and professional bots in the first block.\n3. You get a card with a verdict and a reality check: what someone who bought 3 or 30 seconds after launch actually got.\n\nAdd me to a group and anyone can paste an address. I never ask for keys or funds. Not financial advice.' },
};
// What happened to an example coin after we flagged it live.
const AFTER = {
  pl: { 1: 'Co było dalej: oznaczyliśmy tę monetę jako wysokie ryzyko na żywo, 11 października o 03:21 czasu polskiego. Niecałe 2 minuty później jej cena spadła o 99%.' },
  en: { 1: 'What happened next: we flagged this coin as high risk live, on 11 October at 01:21 UTC. Less than 2 minutes later its price was down 99%.' },
};
function sendMenu(chatId, L) {
  const M = MENU[L];
  return tg('sendMessage', { chat_id: chatId, text: T[L].hello, reply_markup: { inline_keyboard: [
    ...M.ex.map((t, i) => [{ text: t, callback_data: `ex:${i}` }]),
    [{ text: M.how, callback_data: 'how' }, { text: M.site, url: SITE }],
    [{ text: '🇬🇧 English', callback_data: 'lang:en' }, { text: '🇵🇱 Polski', callback_data: 'lang:pl' }],
  ] } });
}
async function handleButton(cq) {
  const chat = cq.message?.chat;
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chat) return;
  const L = langOf.get(chat.id) || ((cq.from?.language_code || '').startsWith('pl') ? 'pl' : 'en');
  const d = cq.data || '';
  if (d.startsWith('ex:')) {
    const i = Number(d.slice(3));
    const ran = await checkCoin(chat, EXAMPLES[i] || EXAMPLES[0], L);
    if (ran !== false && AFTER[L][i]) await tg('sendMessage', { chat_id: chat.id, text: AFTER[L][i] });
    return;
  }
  if (d === 'how') return tg('sendMessage', { chat_id: chat.id, text: MENU[L].howText });
  if (d.startsWith('lang:')) { const nl = d.slice(5) === 'pl' ? 'pl' : 'en'; langOf.set(chat.id, nl); return sendMenu(chat.id, nl); }
}

// On restart (SIGTERM) finish the checks already running instead of cutting them off; messages fetched but not
// yet handled are not confirmed to Telegram, so the next process receives them again.
let stopping = false;
process.on('SIGTERM', async () => {
  stopping = true;
  const t0 = Date.now();
  while (busy.size && Date.now() - t0 < 25_000) await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
});

let offset = 0;
const me = await tg('getMe', {});
console.log(`Bot @${me.result?.username} działa.`);
for (;;) {
  try {
    const u = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
    if (stopping) break;
    for (const up of u.result || []) {
      offset = up.update_id + 1;
      if (up.message) handle(up.message).catch(() => {});
      if (up.callback_query) handleButton(up.callback_query).catch(() => {});
    }
  } catch { await new Promise((r) => setTimeout(r, 2000)); }
}
