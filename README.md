# TrenchTruth

**On-chain truth for memecoin traders.** Paste a pump.fun coin into Telegram and get, in seconds:

- a **risk card**: serial-rugger networks traced through *who funded the creator's wallet*, the creator's
  own launch record, coordinated buys in the creator's Jito bundle and where those coins went (moved or sold),
  professional sniper bots in the first block, early creator sells;
- a **reality simulator**: what would have happened if you had bought 3 or 30 seconds after launch, computed
  from the coin's actual on-chain trades (price impact, fees, take-profit / stop-loss, reaction delay);
- the context nobody shows: **82% of new pump.fun coins die within 5 minutes** (our data: 15,008 launches).

The repo also includes our open-source, dependency-free Solana shred decoder (with support for the new **v1
transaction format, SIMD-0385**), which sees new launches **~170 ms before standard RPC websockets**. We built
it for the sniper experiments behind our findings; the bot itself does not need it (a pasted coin already
exists), and it is the base for the next feature: warnings at the moment a coin launches.

**Try it:** [@TrenchTruthBot](https://t.me/TrenchTruthBot) on Telegram. Paste any pump.fun coin address.

## Caught live: WIFCLAUDIA, 11 Oct 2026

`GdDpqx7i7cbskew6cDNqP56ZbHe6aUYZfX3zSknvpump` launched at 01:12:16 UTC. The creator and 4 other wallets bought
83.28 SOL in the launch's Jito bundle, about 79% of the supply, which completed the bonding curve at once.

- **01:21 UTC:** a check in the bot returned **high risk** (bundle with ~79% of the supply, 5 buys in the first
  block, 1 by a professional bot).
- **01:22:31–01:23:00 UTC:** the PumpSwap pool fell from ~97 SOL to ~6 SOL. The price dropped from 6.0e-7 to
  6.5e-9 SOL per token, **−99%** (measured from the pool's vault balances).

The same night we added **bundle tracing**: the bot now follows the bundle wallets' coins one hop and reports
how much they moved to other wallets and how much they have already sold. For WIFCLAUDIA it shows that the
bundle wallets moved ~79% of the supply to 4 other wallets, and that the insiders have sold about all of it
through them.

> Status: hackathon build (Colosseum Crypto World's Fair, Oct 2026). Research and code were written during the
> hackathon (Oct 5–12, 2026).

## Why

We spent a week trying to make money sniping pump.fun launches the way retail bots do: recording every launch,
backtesting thousands of strategies, building a sniper and running it live. What we learned (details in
[`docs/findings.md`](docs/findings.md)):

- **82%** of new coins are dead 5 minutes after launch.
- Money in the launch block goes to the creator, its bundle wallets and ~440 professional sniper wallets. They
  react in ~30 ms, and our own shred-fed bot, 5–16 ms from detection to send, still landed behind
  6–12 SOL of their buys.
- Even the coins that *look* best 30 s after launch (many buyers, ≥3 SOL raised, good creator record) lose
  **−11% to −16% on average** if you buy then. They survive 3× more often, but the early wallets sell into you.
- A quarter of "fresh, clean" creator wallets are funded by wallets that already financed dozens of launches,
  **91% of which died within 5 minutes**. Wallet-only "dev history" misses them.

Retail traders deserve to see this before they click buy. TrenchTruth shows it, in plain language
(English and Polish).

## How it works

```
The bot (what runs today):
paste address in Telegram ──▶ src/bot.mjs ──▶ src/scan.mjs ──▶ Helius RPC + Jito bundle API
                                                  │  + data/launches.jsonl (launch history, funders, outcomes)
                                                  │  risk signals + simulate()
                                                  ▼
                                        risk card (EN/PL) + "what if you bought"

The launch history (built from our recordings):
Helius websocket ──▶ tools/record-launches ──▶ tools/funders-fetch ──▶ tools/build-db ──▶ data/launches.jsonl

The shred decoder (research and next step, not used by the bot yet):
Solana leader ──shreds──▶ LocalShred / ShredStream proxy ──gRPC entries──▶ src/shreds.mjs
                           (decode Vec<Entry>, legacy/v0/v1 txs, pump.fun create + creator buy,
                            quote mint, holder-reward creator vault)
```

- `src/shreds.mjs`: decodes shred-stream entries into transactions, including **Solana tx v1** (version byte
  `0x81`, signatures at the end) which appeared on mainnet in Sept 2026 and breaks older decoders; recognises
  pump.fun launches from instructions alone (no logs exist yet at shred time): creator, creator buy replayed on
  the curve, non-SOL quote mints, the creator-vault account of holder-reward coins.
- `src/scan.mjs`: `scanMint(mint)`: launch, first 5 minutes of trades, creator's funder, launch history,
  Jito bundle of the create, bundle tracing (one hop: moved vs. sold), signals, verdict, `simulate()`.
- `src/bot.mjs`: Telegram bot (Bot API over HTTPS, no dependencies). Works in DMs and groups.
- `tools/`: launch recorder (websocket, arrival-timed), funder lookup, history builder, shred feed latency
  probe, decoder self-test on real transactions.

## Run

Requirements: Node.js 22+, a Solana RPC key (Helius) in `helius-key.txt` or `HELIUS_KEY`.

```bash
node src/scan.mjs <pump.fun mint>                 # risk card as JSON
BOT_TOKEN=... node src/bot.mjs                    # Telegram bot
node tools/shreds-selftest.mjs 12                 # decoder check on recent real launches
```

Launch history: `data/launches.sample.jsonl` is a sample; build the full file with `tools/record-launches.mjs`,
`tools/funders-fetch.mjs` and `tools/build-db.mjs`.

Secrets (`helius-key.txt`, `bot-token.txt`, `axiom-ref.txt`) are git-ignored.

## Business model

Free bot for traders and Telegram groups (distribution) → revenue from clearly labelled referral links to trading
terminals (e.g. Axiom: 30% of referred users' fees) → paid API / feed for other bots and scanners → premium
alerts. Information, not financial advice.

## License

MIT
