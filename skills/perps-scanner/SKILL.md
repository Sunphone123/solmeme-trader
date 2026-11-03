---
name: perps-scanner
description: Scan all SolMeme perps markets (crypto and stocks on Hyperliquid) for movers, crowded funding and fresh turnover, and analyze one market's trend, ATR, ranges and funding. Use when the user asks what's moving, what to trade, for a market overview, or about one coin's setup before trading.
---

# SolMeme perps scanner

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs <command>` (below: `solmeme`).

- `solmeme scan [--min-volume 5000000] [--stocks] [--limit 6]` — top gainers and losers, crowded longs (highest funding — longs pay) and crowded shorts (lowest funding), fresh turnover (24h volume / open interest).
- `solmeme markets [--sort volume|change|funding|oi] [--limit 20] [--stocks]` — the table of markets.
- `solmeme analyze <coin>` — 1h/4h/24h/7d change, trend (1h EMA20 vs EMA50), hourly ATR, where price sits in the 24h and 7d range, funding and open interest.
- `solmeme quote <coin>` — bid/ask, funding, max leverage.

How to present it: lead with the 3–5 most interesting markets and why (a move on big volume, extreme funding that can squeeze, price at the edge of its 7-day range). Funding is shown as a yearly rate; around +11% a year is the exchange's baseline, far above or below it means one side is crowded. These are observations, not signals: hand off to the perps-trader skill to plan any trade, and run the time machine before risking money.
