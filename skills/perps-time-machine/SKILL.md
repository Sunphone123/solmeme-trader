---
name: perps-time-machine
description: Time machine for a planned SolMeme perps trade — replays thousands of paths built from the market's real recent 5-minute candles and reports the chance of hitting take profit, stop loss or liquidation within a time horizon, the expected value after fees and the break-even win rate. Use before opening a position, or when the user asks about the odds, probability or expected value of a trade or of their TP/SL levels.
---

# SolMeme time machine

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs sim <coin> --side long|short --tp <px> --sl <px> [--lev 3] [--hours 24] [--paths 10000] [--days 14] [--usd 100] [--entry <px>] [--keep-drift]`

What it does: stitches random one-hour blocks of the last `--days` of real 5-minute candles into `--paths` futures of `--hours` each and checks every candle's high and low against TP, SL and the estimated liquidation price (if a candle touches both stop and target, the stop counts — the cautious choice). Fees (exchange 0.045% + SolMeme 0.035% per side) and current funding are included. By default the window's trend is removed so only volatility is replayed; `--keep-drift` assumes the recent trend continues.

How to report: give the four chances (TP, SL, liquidation, still open), the median time to TP/SL, the expected value per trade and the break-even win rate versus the simulated one. Then interpret honestly:
- a TP far away with a tight stop will usually lose more often — that is fine only if the payoff covers it (compare with break-even);
- negative expected value after fees means the levels do not pay for themselves on volatility alone; the user needs a real edge (a reason the market should move their way) to take it;
- it is a simulation of past volatility, not a forecast of direction.
Try 2–3 variants of stop/target/horizon if the user is choosing levels.
