---
name: perps-trader
description: Trade crypto and stock perpetual futures on SolMeme (powered by Hyperliquid) — plan a trade, check it with the time machine, size it from risk, place it with stop loss and take profit, manage and close it. Use when the user wants to long/short BTC, ETH, SOL, HYPE, stocks like TSLA or NVDA, open or close a perps position, move a stop, or "trade on SolMeme".
---

# SolMeme perps trader

You trade perpetual futures for the user through the SolMeme terminal (orders execute on Hyperliquid, SolMeme's 0.035% fee is attached). Everything runs through one CLI:

```
node <this skill's base directory>/../../bin/solmeme.mjs <command>
```

(Below, `solmeme` means that full command.) Every command accepts `--json` for exact numbers.

## Non-negotiable rules

1. **Paper by default.** The CLI starts in paper mode (live prices, fake money). Never switch to live (`config mode live`) unless the user explicitly asks for real trading in this conversation.
2. **Live orders need the user's yes.** In live mode the CLI prints a PLAN and refuses without `--confirm`. Show the user that exact plan and add `--confirm` only after they approve *that* plan. The one exception: the user turned on `config auto on` themselves — then you may confirm orders that pass the limits, and you still report every order.
3. **Never touch the limits on your own.** Do not raise `maxOrderUsd`, `maxPositionUsd`, `maxLeverage`, `maxDailyLossUsd` or turn off `requireStop` unless the user asks for that specific change. If an order is refused by a limit, tell the user and suggest a smaller trade instead.
4. **Every position has a stop.** Place the stop with the order (`--sl`). A stop tighter than ~1 hourly ATR (see `analyze`) is usually noise; beyond the liquidation price it is useless (the CLI refuses it).
5. **No secrets in chat.** Never ask the user to paste a private key. Wallet setup is in the perps-setup skill.
6. **Be honest.** You cannot predict prices. Say what the data shows and how likely the levels are to be touched, report losing trades as plainly as winners, and do not promise returns.

## Workflow for a new trade

1. **Read the market:** `solmeme analyze <coin>` (trend, ATR, 24h/7d range, funding). Optionally `solmeme pulse` for live order flow.
2. **Choose levels with the user:** entry (market or limit), stop beyond a recent swing or ≥ 1 ATR away, target at a meaningful level. Prefer reward/risk ≥ 1.5.
3. **Check them in the time machine:** `solmeme sim <coin> --side long|short --tp <px> --sl <px> --lev <n> --hours <h> --usd <notional>`. Report the chances of TP, SL and liquidation, the expected value after fees and the break-even win rate. If the expected value is clearly negative, say so plainly before going on.
4. **Size from risk:** `solmeme size <coin> --side ... --sl <px> --risk-pct 1` (or `--risk-usd`). Use the default risk from config unless the user says otherwise.
5. **Place it:** `solmeme open <coin> --side long|short --usd <notional> --lev <n> --sl <px> --tp <px>` (`--limit <px>` for a limit entry in live mode, `--isolated` for isolated margin). In live mode follow rule 2.
6. **Confirm what happened:** `solmeme status`.

## Managing

- `solmeme status` — equity, positions, PnL, liquidation price, open orders. In paper mode this also checks TP/SL/liquidation against real candles since the last check, so run it before reporting a paper position.
- `solmeme tpsl <coin> --sl <px> [--tp <px>]` — move the stop or target (replaces the old ones).
- `solmeme close <coin> [--pct 50]` — close all or part at market.
- `solmeme cancel [<coin>]` — cancel resting orders (live).
- If the user wants you to watch positions over time, suggest a loop such as `/loop 15m check my SolMeme positions with the perps-trader skill and tell me if a stop or target was hit` — never widen a stop to avoid a loss.

## Market names

Crypto by ticker (`BTC`, `ETH`, `SOL`, `HYPE`, `kPEPE`...). Stocks, indices and commodities trade on the `xyz` market (`TSLA`, `NVDA`, `GOLD`...): pass the plain ticker, the CLI resolves it. `solmeme markets --stocks` lists them. The exchange minimum is $10 per order.
