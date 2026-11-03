---
name: perps-pulse
description: Live pulse of SolMeme perps — listen to the real-time trade stream of the busiest Hyperliquid markets for a few seconds and report big prints (whales), the buy/sell balance per market and the most crowded funding. Use when the user asks what whales are doing, who is buying or selling right now, or for live order flow.
---

# SolMeme perps pulse

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs pulse [--seconds 30] [--min-usd 50000] [--top 12] [--stocks]`

It subscribes to live trades of the top markets by volume for the given seconds (max 120), then prints:
- **big prints** — single trades at or above `--min-usd`, with side, size, price and time;
- **buy/sell balance** — taker volume bought vs sold per market in the window, net and share of buys;
- **most crowded funding** — markets where longs or shorts pay the most.

Explain it in plain words: "in the last 30 seconds takers sold $1.2M of BTC and bought $23K". A short window is a snapshot, not a trend — say so, and run it again or lengthen `--seconds` before drawing conclusions. For a trade, hand off to perps-trader.
