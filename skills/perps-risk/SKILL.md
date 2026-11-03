---
name: perps-risk
description: Risk manager for SolMeme perps — position size from the stop distance and a risk percentage, leverage and liquidation checks, daily loss limit and the hard limits the CLI enforces. Use when the user asks how much to buy, how big a position should be, how much they can lose, about leverage or liquidation, or to change their risk limits.
---

# SolMeme risk manager

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs <command>` (below: `solmeme`).

- `solmeme size <coin> --side long|short --sl <px> [--risk-pct 1 | --risk-usd 10] [--entry <px>] [--lev 3]` — how many coins and dollars so that hitting the stop loses the chosen risk (fees included), the margin at that leverage, and whether it fits the per-order limit.
- `solmeme config show` — the limits: `maxOrderUsd`, `maxPositionUsd` (per coin), `maxLeverage`, `maxDailyLossUsd` (UTC day, realized), `requireStop`, `riskPerTradePct`. `open` refuses anything outside them, in paper and live alike.

Principles to apply and explain:
- Risk a small fixed share per trade (1% by default). Size comes from the stop distance, not from a hunch; leverage only changes the margin you lock, not the risk, as long as the stop is well inside the liquidation price.
- Lower leverage keeps liquidation far away: at 3x liquidation is roughly 30% away, at 20x about 4%.
- After the daily loss limit is hit, stop opening new trades until the next UTC day. Never suggest raising a limit to get around a loss.
- Change limits only when the user asks: `solmeme config set <limit> <value>`.
