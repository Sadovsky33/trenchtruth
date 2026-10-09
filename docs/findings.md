# What we measured (Oct 5–8, 2026)

All numbers are from our own recordings of pump.fun on Solana mainnet:
- a 12-hour overnight recording (~25k tokens);
- three arrival-timed recordings from a server in Frankfurt (6.10 20:56–22:56 UTC, 7.10 04:56–07:56 UTC,
  7.10 15:00–18:00 UTC; 15,008 non-mayhem launches);
- a live test with real money.

## 1. Most coins die immediately
| | coins | dead 5 min after launch |
|---|---|---|
| all launches | 15,008 | **82%** |
| creator wallet with ≥2 earlier launches, ≥80% dead | 4,527 | 94% |
| creator wallet with ≥2 earlier launches, <50% dead | 289 | 20% |

## 2. Funding-source tracing finds serial ruggers hiding behind fresh wallets
For each creator wallet we looked up the account that sent it its first SOL (7,983 wallets). Among launches from
**fresh** wallets (no earlier launch, so "dev history" looks clean):

| fresh creator wallet, funded by… | launches | dead in 5 min |
|---|---|---|
| a wallet with no bad record | 4,712 | 78% |
| **a wallet whose other funded creators launched ≥2 coins, ≥80% dead** | **2,093 (24%)** | **91%** |
| a wallet whose funded creators did well (<50% dead) | 122 | 59% |

The same holds in each of the three sessions separately (89.5%, 93.2%, 89.7%). Only outcomes known before each
launch are used (no look-ahead).

## 3. "Good-looking" coins still lose money for a buyer at +30 s
A simple score learned on the first session (signals: creator and funder record, creator buy, buyers and SOL in
the first 30 s, creator selling) picks survivors 3× better on the two later sessions (top 10%: ~54% survive vs
18%). But buying those at +30 s and selling at +5 min returns **−11% to −16% on average (median −25% to −32%)**
before fees. Early wallets sell into the buyers the signals attract.

## 4. Who wins in the launch block
- Professional snipers (wallets buying in the creation slot of ≥4 different creators' coins) earned
  +1% to +8% realised in every session.
- 88% of them react on their own, not inside the creator's Jito bundle, landing ~30 ms after the create.
- They pay tips to Helius Sender (SWQoS), Nozomi and Astralane, plus ~11M µlamports/CU priority fees.

Timing model (arrival-ordered replay): robust settings exist only at ≤20–30 ms after the create in 4 of 5
sessions; at ≥50 ms none.

## 5. Our live test
- Setup: shred feed (~168 ms earlier than websockets, 653 launches measured), send 5–16 ms after detection,
  SWQoS route, high priority fee.
- Result: 9 of 15 buys landed in the creation block, 127–837 transactions after the create, but behind
  6–12 SOL of other buys (price already +20–60%).
- Counterfactual: if all 15 had filled where they landed, every exit rule averaged −3.5% to −22% before fees.

**Conclusion:** retail sniping of pump.fun launches is a losing game. What retail traders need is information:
who is behind the coin, and what really happens to someone who buys it a few seconds late.
