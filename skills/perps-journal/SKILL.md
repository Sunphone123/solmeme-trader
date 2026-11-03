---
name: perps-journal
description: Trading journal for SolMeme perps — every paper and live trade with entry, exit, PnL and reason, win rate, profit factor, exchange fills, and the public SolMeme profile with shareable PnL cards. Use when the user asks how their trading is going, for PnL, trade history, statistics, a review of past trades, or a PnL card to share.
---

# SolMeme trading journal

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs <command>` (below: `solmeme`).

- `solmeme journal [--mode paper|live] [--limit 20]` — closed trades, win rate, total PnL, average win and loss, profit factor, and the latest entries (opens, closes with reason: take profit, stop loss, liquidation, manual).
- `solmeme fills [--limit 20]` — live fills straight from the exchange, with fees.
- `solmeme status` — open positions and today's realized PnL.
- `solmeme profile` — the public SolMeme profile of the wallet (live trades appear on the SolMeme perps leaderboard; the profile has PnL cards to share).

When reviewing, be specific and honest: which setups worked, whether stops were respected, average loss versus average win, fees paid. Do not hide losing streaks. A useful review ends with one concrete change for the next trades.
