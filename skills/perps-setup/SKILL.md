---
name: perps-setup
description: Set up SolMeme perps trading for Claude — create or import the wallet, show the deposit address, bridge SOL in, convert it to margin, withdraw back to Solana, and switch between paper and live mode or adjust risk limits. Use when the user wants to start trading SolMeme perps from Claude, fund the account, withdraw, or change limits.
---

# SolMeme perps setup

CLI: `node <this skill's base directory>/../../bin/solmeme.mjs <command>` (below: `solmeme`). State lives in `~/.solmeme` on the user's computer; keys never leave it.

## Wallet

- `solmeme wallet show` — Solana wallet, its perps account, SOL balance, public SolMeme profile. Run this first; if it says there is no wallet, offer one of:
  - **New wallet:** `solmeme wallet create`. Then tell the user to back it up themselves by running `solmeme wallet export --show-secret` in their own terminal (never run export yourself and never ask for the key).
  - **Use their SolMeme terminal wallet** (same perps account as on sol-meme.com): ask the user to export the key on sol-meme.com (Terminal → wallet → Show private key), save it into a file themselves, e.g. `~/.solmeme/import.txt`, and tell you when it's done. Then run `solmeme wallet import --file ~/.solmeme/import.txt` — the CLI imports it and deletes the file. Do not read the file yourself.
- The perps account is derived from the Solana key with the same rule as sol-meme.com, so importing the same key on the site shows the same positions there.

## Funding (real money — live mode only)

1. `solmeme deposit-address` — a bridge (Unit) address verified against the guardians' signatures. The user can send SOL (minimum 0.12) to it from any Solana wallet.
   Or, if this wallet already holds SOL: `solmeme deposit --sol <n>` (shows a plan; `--confirm` after the user approves).
2. After a few minutes: `solmeme sweep` — sells the bridged SOL for USDC and moves it to perps margin.
3. `solmeme status` — check equity.

Withdraw: `solmeme withdraw --usd <n> [--to <solana address>]` (default: this wallet). Plan first, `--confirm` after approval. The bridge minimum is 0.12 SOL.

## Modes and limits

- `solmeme config show`
- `solmeme config mode paper|live` — switch to live only when the user explicitly asks to trade real money, and say so clearly.
- `solmeme config paper-reset 1000` — fresh paper account.
- `solmeme config set <limit> <value>` — only when the user asks. Limits: `maxOrderUsd` (default 100), `maxPositionUsd` (200), `maxLeverage` (5), `maxDailyLossUsd` (25), `requireStop` (true), `riskPerTradePct` (1). The CLI enforces them on every order.
- `solmeme config auto on|off` — lets you confirm live orders inside the limits without asking each time. Only the user turns it on; mention the risk when they do.
- `solmeme config ref <solana wallet>` — the trader came with an invite: SolMeme's fee drops to 0.032%.
