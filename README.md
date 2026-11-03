# SolMeme Trader — perps skills for Claude

Let Claude trade perpetual futures on [SolMeme](https://sol-meme.com): crypto (BTC, ETH, SOL, HYPE…) and stocks (TSLA, NVDA…) on Hyperliquid, from your Claude Code chat. Paper trading by default.

Seven skills that Claude picks up on its own:

| Skill | What it does |
|---|---|
| **perps-scanner** | Movers, crowded funding, fresh turnover across every market; trend, ATR and ranges of one coin |
| **perps-pulse** | Listens to the live trade stream: big prints, buy/sell balance, crowded funding |
| **perps-time-machine** | Replays 10,000 paths of the market's real recent candles: chances of hitting your take profit, stop or liquidation, expected value after fees |
| **perps-risk** | Position size from your stop and risk %, leverage and liquidation checks, daily loss limit |
| **perps-trader** | Plans and places trades with stop loss and take profit, moves stops, closes |
| **perps-journal** | Every trade with PnL and reason, win rate, profit factor, your public SolMeme profile with PnL cards |
| **perps-setup** | Wallet, deposit via the Solana bridge, withdraw, paper/live mode, limits |

## Install

```
/plugin marketplace add <github-owner>/solmeme-trader
/plugin install solmeme-trader@solmeme
```

Needs Node.js 18+. Then just ask: *"scan SolMeme perps"*, *"plan a SOL long with a 1 ATR stop and check it in the time machine"*, *"how did my trades go this week?"*.

## Safety

- **Paper mode first.** Live prices, the same fees, no money. Claude switches to live only when you ask.
- **Every live order needs your yes.** The CLI prints the plan and refuses without `--confirm`; Claude asks you first. You can allow automatic confirmation inside your limits with `config auto on`.
- **Hard limits in code**, not just in prompts: max order ($100), max position per coin ($200), max leverage (5x), daily loss limit ($25), mandatory stop loss. Change them yourself with `config set`.
- **Your keys stay on your computer** in `~/.solmeme`. Claude never asks for them; import goes through a file you create, which is deleted after import.
- **The same account as on sol-meme.com.** The perps account is derived from your Solana key with the same rule as the SolMeme terminal: import the key there and you see Claude's positions live.

Trading perpetual futures with leverage can lose more than you expect, fast. The time machine replays past volatility; it does not predict prices. Nothing here is financial advice.

## Fees

Hyperliquid's own taker fee (0.045% on the base tier) plus SolMeme's 0.035% (0.032% with an invite). Orders from the skill are tagged with a `SolMemeSkill` client order id.

## Development

```
npm install
npm run build      # bundles src/ into bin/solmeme.mjs (committed, so users need no npm install)
node bin/solmeme.mjs help
```

MIT license.
