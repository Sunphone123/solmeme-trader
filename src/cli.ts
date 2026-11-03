import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { analyze, pulse, scan } from './scan.js';
import { book, fundingApr, market, markets, type Market } from './hl.js';
import { createWallet, hasWallet, importWallet, loadWallet, b58encode } from './keys.js';
import { account, cancelAll, close, fills, friendlyError, open, registerBoard, setTpsl, solmemeFee, statuses } from './live.js';
import { paperAccount, paperClose, paperOpen, paperTpsl, PAPER_FEE_RATE, resetPaper } from './paper.js';
import { checkOpen, realizedToday, sizeFromRisk } from './risk.js';
import { simulate } from './sim.js';
import { appendJournal, DEFAULT_CONFIG, HOME, loadConfig, PATHS, readJournal, saveConfig, type Config } from './store.js';
import { depositSol, solBalance, sweep, unitAddress, UNIT_MIN_SOL, withdraw } from './bridge.js';

const VERSION = '0.1.0';

// ---------- args ----------
const argv = process.argv.slice(2);
const pos: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
    else flags[k] = true;
  } else pos.push(a);
}
const has = (k: string) => flags[k] !== undefined;
const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
const num = (k: string) => {
  const v = str(k);
  if (v === undefined) return undefined;
  const n = Number(v.replace(/[$,_]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
  return n;
};
const JSON_OUT = has('json');

// ---------- formatting ----------
const usd = (n: number, d = 2) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const sgn = (n: number, d = 2) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pct = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`);
const px = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return a >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : a >= 1 ? n.toFixed(a >= 100 ? 2 : 4) : n.toPrecision(5);
};
const big = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
function table(rows: (string | number)[][], head: string[]) {
  const all = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return all.map((r, j) => r.map((c, i) => String(c).padEnd(w[i]!)).join('  ') + (j === 0 ? '\n' + w.map((x) => '-'.repeat(x)).join('  ') : '')).join('\n');
}
const out = (text: string, data: unknown) => console.log(JSON_OUT ? JSON.stringify(data, null, 2) : text);

const cfg = loadConfig();
const mode = (str('mode') as Config['mode'] | undefined) ?? cfg.mode;

function needConfirm(plan: string) {
  if (mode !== 'live') return;
  if (has('confirm') || cfg.autoConfirm) return;
  console.log(plan + '\n\nNOT EXECUTED (live mode). Show this plan to the user; after they approve, run the same command with --confirm.');
  process.exit(3);
}

const HELP = `solmeme ${VERSION} — trade SolMeme perps (Hyperliquid) from Claude. Mode: ${mode.toUpperCase()}  (state in ${HOME})

WALLET
  wallet create                     new Solana wallet + its SolMeme perps account (same rule as sol-meme.com)
  wallet import --file <path>       import a base58 key (SolMeme/Phantom export); the file is deleted after import
  wallet show                       addresses (never the key)
  wallet export --show-secret       print the key, to import this wallet on sol-meme.com (user only)
  deposit-address                   verified bridge address: send SOL (min ${UNIT_MIN_SOL}) from any Solana wallet
  deposit --sol <n> [--confirm]     send SOL from this wallet through the bridge
  sweep                             convert arrived SOL to USDC margin
  withdraw --usd <n> [--to <solana address>] [--confirm]

MARKET
  markets [--sort volume|change|funding|oi] [--limit 20] [--stocks]
  scan [--min-volume 5000000] [--stocks] [--limit 6]       movers, funding extremes, fresh turnover
  analyze <coin>                    trend, ATR, 24h/7d range, funding, OI
  pulse [--seconds 30] [--min-usd 50000] [--top 12]       live big prints, buy/sell balance, crowded funding
  quote <coin>                      bid/ask, funding, max leverage

PLAN
  sim <coin> --side long|short --tp <px> --sl <px> [--lev 3] [--hours 24] [--paths 10000] [--days 14] [--usd 100] [--keep-drift]
  size <coin> --side long|short --sl <px> [--risk-usd <n> | --risk-pct <n>] [--lev 3]

TRADE  (paper by default; live needs "config mode live" and --confirm per order unless autoConfirm)
  open <coin> --side long|short (--usd <n> | --size <n> | --risk-usd <n> | --risk-pct <n>) --lev <n> --sl <px> [--tp <px>] [--limit <px>] [--isolated] [--confirm]
  close <coin> [--pct 100] [--confirm]
  tpsl <coin> [--tp <px>] [--sl <px>] [--confirm]
  cancel [<coin>] [--confirm]
  status                            balance, positions, orders (paper: also checks TP/SL on real candles)
  journal [--limit 20] [--mode paper|live]
  profile                           public SolMeme profile with PnL cards

CONFIG
  config show | config mode paper|live | config auto on|off | config set <limit> <value> | config ref <solana wallet> | config paper-reset <usd>
  limits: maxOrderUsd maxPositionUsd maxLeverage maxDailyLossUsd requireStop riskPerTradePct

Add --json to any command for machine-readable output.`;

async function equityNow() {
  if (mode === 'paper') return (await paperAccount()).equity;
  return (await account(loadWallet().perps.address)).equity;
}
async function exposureUsd(m: Market) {
  if (mode === 'paper') {
    const a = await paperAccount();
    const p = a.positions.find((x) => x.coin === m.coin);
    return p ? p.value : 0;
  }
  const a = await account(loadWallet().perps.address);
  const p = a.positions.find((x) => x.coin === m.coin);
  return p ? Math.abs(p.value) : 0;
}

async function main() {
  const [cmd, sub] = pos;
  switch (cmd) {
    case undefined:
    case 'help':
      return console.log(HELP);

    case 'wallet': {
      if (sub === 'create') {
        const w = createWallet();
        return out(`Wallet created and stored in ${PATHS.wallet} (only on this computer).\nSolana wallet: ${w.solana}\nPerps account: ${w.perps.address}\n\nBack it up: run "wallet export --show-secret" yourself and keep the key offline. Import the same key on sol-meme.com (Terminal → wallet → Import a private key) to see this account in the SolMeme terminal.`, { solana: w.solana, perps: w.perps.address });
      }
      if (sub === 'import') {
        const file = str('file');
        let raw = '';
        if (file) {
          raw = readFileSync(file, 'utf8');
        } else if (!process.stdin.isTTY) {
          raw = readFileSync(0, 'utf8');
        } else throw new Error('Put the key in a file and run: wallet import --file <path> (the file is deleted after import).');
        const w = importWallet(raw);
        if (file && existsSync(file)) unlinkSync(file);
        return out(`Imported. Solana wallet: ${w.solana}\nPerps account: ${w.perps.address} (the same account as in the SolMeme terminal for this wallet)${file ? `\nDeleted ${file}.` : ''}`, { solana: w.solana, perps: w.perps.address });
      }
      if (sub === 'export') {
        if (!has('show-secret')) throw new Error('This prints the private key. Run it yourself with --show-secret, never paste the key into a chat.');
        const w = loadWallet();
        return console.log(b58encode(w.secret));
      }
      const w = loadWallet();
      const sol = await solBalance(w.solana).catch(() => null);
      return out(`Solana wallet: ${w.solana}${sol !== null ? `  (${sol.toFixed(4)} SOL)` : ''}\nPerps account: ${w.perps.address}\nSolMeme profile: https://sol-meme.com/u/${w.solana}`, { solana: w.solana, perps: w.perps.address, sol });
    }

    case 'deposit-address': {
      const w = loadWallet();
      const a = await unitAddress('deposit', w.perps.address);
      return out(`Send SOL on Solana to:\n${a}\n\nMinimum ${UNIT_MIN_SOL} SOL. It arrives as SOL on Hyperliquid in a few minutes; then run "sweep" to turn it into USDC margin.\n(Address verified against 2 of 3 Unit guardian signatures.)`, { address: a, minSol: UNIT_MIN_SOL });
    }

    case 'deposit': {
      if (mode !== 'live') throw new Error('Deposits are real money: switch with "config mode live" first.');
      const sol = num('sol');
      if (!sol) throw new Error('Give --sol <amount>');
      const w = loadWallet();
      needConfirm(`PLAN: send ${sol} SOL from ${w.solana} through the Unit bridge to perps account ${w.perps.address}.`);
      const r = await depositSol(w, sol);
      appendJournal({ mode: 'live', action: 'deposit', sol, sig: r.sig });
      return out(`Sent ${sol} SOL. Transaction: https://solscan.io/tx/${r.sig}\nIt lands on Hyperliquid in a few minutes; then run "sweep".`, r);
    }

    case 'sweep': {
      const w = loadWallet();
      const r = await sweep(w);
      if (r.sold) appendJournal({ mode: 'live', action: 'sweep', sol: r.sold, usdc: r.usdc });
      return out(r.sold ? `Sold ${r.sold} SOL for ${usd(r.usdc)} and moved it to perps margin.` : 'No bridged SOL on the account yet. Deposits take a few minutes; try again shortly.', r);
    }

    case 'withdraw': {
      if (mode !== 'live') throw new Error('Withdrawals are real money: switch with "config mode live" first.');
      const amt = num('usd');
      if (!amt) throw new Error('Give --usd <amount>');
      const w = loadWallet();
      const to = str('to') ?? w.solana;
      needConfirm(`PLAN: withdraw ${usd(amt)} from perps as SOL to ${to} through the Unit bridge.`);
      const r = await withdraw(w, amt, to);
      appendJournal({ mode: 'live', action: 'withdraw', usd: amt, sol: r.sol, to: r.to });
      return out(`Withdrawing ${r.sol} SOL to ${r.to}. It arrives on Solana in a few minutes.`, r);
    }

    case 'markets': {
      const sort = str('sort') ?? 'volume';
      const limit = num('limit') ?? 20;
      let list = (await markets()).filter((m) => has('stocks') || m.kind === 'crypto');
      const key: Record<string, (m: Market) => number> = { volume: (m) => m.volume24h, change: (m) => Math.abs(m.change24h), funding: (m) => Math.abs(m.funding), oi: (m) => m.openInterestUsd };
      list = list.sort((a, b) => (key[sort] ?? key.volume!)(b) - (key[sort] ?? key.volume!)(a)).slice(0, limit);
      return out(table(list.map((m) => [m.label + (m.kind === 'stock' ? ' (stock)' : ''), px(m.mark), pct(m.change24h), big(m.volume24h), big(m.openInterestUsd), pct(fundingApr(m.funding), 1) + ' apr', `${m.maxLeverage}x`]), ['market', 'price', '24h', 'volume', 'open int.', 'funding', 'max']), list);
    }

    case 'quote': {
      const m = await market(sub ?? '');
      const b = await book(m.coin);
      return out(`${m.label}  bid ${px(b.bid)}  ask ${px(b.ask)}  mark ${px(m.mark)}  24h ${pct(m.change24h)}\nfunding ${pct(m.funding * 100, 4)}/h (${pct(fundingApr(m.funding), 1)} a year; ${m.funding >= 0 ? 'longs pay shorts' : 'shorts pay longs'})\nvolume ${big(m.volume24h)}  open interest ${big(m.openInterestUsd)}  max leverage ${m.maxLeverage}x${m.onlyIsolated ? ' (isolated only)' : ''}`, { market: m, bid: b.bid, ask: b.ask });
    }

    case 'scan': {
      const r = await scan({ minVolume: num('min-volume') ?? 5e6, stocks: has('stocks'), limit: num('limit') ?? 6 });
      const row = (m: Market) => [m.label, px(m.mark), pct(m.change24h), big(m.volume24h), pct(fundingApr(m.funding), 0) + ' apr'];
      const H = ['market', 'price', '24h', 'volume', 'funding'];
      const text = [
        `${r.count} markets with 24h volume ≥ ${big(num('min-volume') ?? 5e6)}`,
        '\nTOP GAINERS\n' + table(r.gainers.map(row), H),
        '\nTOP LOSERS\n' + table(r.losers.map(row), H),
        '\nCROWDED LONGS (highest funding: longs pay)\n' + table(r.fundingHigh.map(row), H),
        '\nCROWDED SHORTS (lowest funding: shorts pay)\n' + table(r.fundingLow.map(row), H),
        '\nFRESH TURNOVER (24h volume / open interest)\n' + table(r.turnover.map((m) => [...row(m), (m.volume24h / Math.max(1, m.openInterestUsd)).toFixed(1) + 'x']), [...H, 'vol/OI']),
      ].join('\n');
      return out(text, r);
    }

    case 'analyze': {
      const a = await analyze(sub ?? '');
      return out(
        `${a.market.label} ${px(a.price)}  1h ${pct(a.change.h1)}  4h ${pct(a.change.h4)}  24h ${pct(a.change.h24)}  7d ${pct(a.change.d7)}\n` +
          `trend (1h EMA20 vs EMA50): ${a.trend}  (${px(a.ema20)} vs ${px(a.ema50)})\n` +
          `ATR 1h: ${px(a.atr1h)} (${a.atrPct.toFixed(2)}% of price) — a stop closer than ~1 ATR is likely noise\n` +
          `24h range ${px(a.range24h.lo)} – ${px(a.range24h.hi)} (price at ${a.range24h.posPct.toFixed(0)}% of it)\n` +
          `7d range ${px(a.range7d.lo)} – ${px(a.range7d.hi)} (price at ${a.range7d.posPct.toFixed(0)}% of it)\n` +
          `funding ${pct(a.fundingApr, 1)} a year  open interest ${big(a.openInterestUsd)}  volume ${big(a.volume24h)}`,
        a,
      );
    }

    case 'pulse': {
      const secs = Math.min(120, num('seconds') ?? 30);
      const r = await pulse({ minUsd: num('min-usd') ?? 50_000, top: num('top') ?? 12, seconds: secs, stocks: has('stocks') });
      const text = [
        `PULSE — ${secs}s of live trades on ${r.watched.join(', ')}`,
        r.big.length ? '\nBIG PRINTS\n' + table(r.big.map((t) => [t.coin, t.side, big(t.usd), px(t.px), new Date(t.at).toISOString().slice(11, 19)]), ['market', 'side', 'size', 'price', 'time (UTC)']) : `\nNo single print above ${big(num('min-usd') ?? 50_000)} in this window.`,
        r.balance.length ? '\nBUY/SELL BALANCE (taker volume in the window)\n' + table(r.balance.map((b) => [b.coin, big(b.buy), big(b.sell), (b.net >= 0 ? 'buyers ' : 'sellers ') + big(Math.abs(b.net)), `${b.buyShare.toFixed(0)}% buys`, String(b.trades)]), ['market', 'bought', 'sold', 'net', 'share', 'trades']) : '',
        '\nMOST CROWDED FUNDING\n' + table(r.crowded.map((m) => [m.label + (m.kind === 'stock' ? ' (stock)' : ''), pct(fundingApr(m.funding), 0) + ' apr', m.funding >= 0 ? 'longs pay' : 'shorts pay', big(m.openInterestUsd)]), ['market', 'funding', 'who pays', 'open int.']),
      ].join('\n');
      return out(text, r);
    }

    case 'sim': {
      const side = str('side') as 'long' | 'short' | undefined;
      if (side !== 'long' && side !== 'short') throw new Error('Give --side long or --side short');
      const r = await simulate({ coin: sub ?? '', side, entry: num('entry'), tp: num('tp'), sl: num('sl'), leverage: num('lev') ?? 3, hours: num('hours') ?? 24, paths: Math.min(50000, num('paths') ?? 10000), lookbackDays: num('days') ?? 14, notional: num('usd'), keepDrift: has('keep-drift') });
      const P = r.probs;
      const text =
        `TIME MACHINE — ${r.market.label} ${side} ${r.notional ? usd(r.notional, 0) : ''} at ${px(r.entry)}, ${num('lev') ?? 3}x, next ${r.hours}h\n` +
        `${r.paths.toLocaleString('en-US')} paths built from ${r.candlesUsed.toLocaleString('en-US')} real 5-minute candles of the last ${r.lookbackDays} days (daily volatility ≈ ${r.dailyVolPct.toFixed(1)}%)\n\n` +
        table(
          [
            ['take profit ' + px(num('tp')), P.tp.toFixed(1) + '%', r.medianMinutes.tp ? `~${Math.round(r.medianMinutes.tp / 60 * 10) / 10}h` : '—', sgn(r.pnl.tp)],
            ['stop loss ' + px(num('sl')), P.sl.toFixed(1) + '%', r.medianMinutes.sl ? `~${Math.round(r.medianMinutes.sl / 60 * 10) / 10}h` : '—', sgn(r.pnl.sl)],
            ['liquidation ≈' + px(r.liq), P.liq.toFixed(1) + '%', '', sgn(r.pnl.liq)],
            [`still open after ${r.hours}h`, P.open.toFixed(1) + '%', '', `${sgn(r.pnl.openP10)} … ${sgn(r.pnl.openP90)} (median ${sgn(r.pnl.openP50)})`],
          ],
          ['outcome', 'chance', 'median time', 'PnL incl. fees'],
        ) +
        `\n\nexpected value ≈ ${sgn(r.pnl.expected)} per trade (funding ${sgn(r.pnl.funding)})` +
        (r.breakEvenWinRate !== null ? `\nbreak-even: TP must win ${r.breakEvenWinRate.toFixed(1)}% of resolved trades; simulated ${(P.tp + P.sl > 0 ? (P.tp / (P.tp + P.sl)) * 100 : 0).toFixed(1)}%` : '') +
        (r.keptDrift
          ? `\n\nPaths include the window's trend (${pct(r.windowTrendPct, 1)} over ${r.lookbackDays} days) — that is an assumption the trend continues.`
          : `\n\nThe window's trend (${pct(r.windowTrendPct, 1)} over ${r.lookbackDays} days) was removed: this replays volatility only, with no view on direction. It shows how likely the levels are to be touched, not where price will go. Add --keep-drift to assume the trend continues.`);
      return out(text, r);
    }

    case 'size': {
      const m = await market(sub ?? '');
      const side = str('side');
      const sl = num('sl');
      if (!sl || (side !== 'long' && side !== 'short')) throw new Error('Give --side long|short and --sl <price>');
      const b = await book(m.coin);
      const price = num('entry') ?? (side === 'long' ? b.ask : b.bid);
      const eq = await equityNow();
      const riskUsd = num('risk-usd') ?? (eq * (num('risk-pct') ?? cfg.limits.riskPerTradePct)) / 100;
      const s = sizeFromRisk(price, sl, riskUsd, PAPER_FEE_RATE);
      const lev = num('lev') ?? 3;
      const capped = Math.min(s.notional, cfg.limits.maxOrderUsd);
      return out(
        `${m.label} ${side} at ${px(price)}, stop ${px(sl)} (${(Math.abs(price - sl) / price * 100).toFixed(2)}% away)\n` +
          `risk ${usd(riskUsd)} of equity ${usd(eq)} → size ${s.size.toPrecision(5)} ${m.label} = ${usd(s.notional)} notional, margin ${usd(s.notional / lev)} at ${lev}x` +
          (capped < s.notional ? `\nYour limit per order is ${usd(cfg.limits.maxOrderUsd)}: use --usd ${capped.toFixed(0)} (risk then ${usd(riskUsd * capped / s.notional)}).` : '') +
          (s.notional < 10 ? '\nBelow the $10 exchange minimum: risk more or widen the stop.' : ''),
        { price, sl, riskUsd, equity: eq, ...s, leverage: lev, cappedNotional: capped },
      );
    }

    case 'open': {
      const m = await market(sub ?? '');
      const side = str('side');
      if (side !== 'long' && side !== 'short') throw new Error('Give --side long or --side short');
      const isBuy = side === 'long';
      const lev = num('lev');
      if (!lev) throw new Error('Give --lev <leverage>');
      const sl = num('sl');
      const tp = num('tp');
      const limitPx = num('limit');
      if (limitPx && mode === 'paper') throw new Error('Paper mode fills market orders only. Drop --limit or use live mode.');
      const b = await book(m.coin);
      const price = limitPx ?? (isBuy ? b.ask : b.bid);
      let size = num('size');
      if (!size && num('usd')) size = num('usd')! / price;
      if (!size && (num('risk-usd') || num('risk-pct'))) {
        if (!sl) throw new Error('Risk sizing needs --sl');
        const riskUsd = num('risk-usd') ?? ((await equityNow()) * num('risk-pct')!) / 100;
        size = sizeFromRisk(price, sl, riskUsd, PAPER_FEE_RATE).size;
      }
      if (!size) throw new Error('Give --usd, --size, --risk-usd or --risk-pct');
      const notional = size * price;
      const chk = checkOpen(cfg, mode, { market: m, isBuy, notional, leverage: lev, price, sl, tp, existingUsd: await exposureUsd(m) });
      const plan =
        `PLAN (${mode.toUpperCase()}): ${side} ${m.label} ${size.toPrecision(5)} (~${usd(notional)}) at ${limitPx ? 'limit ' + px(limitPx) : 'market ~' + px(price)}, ${lev}x ${has('isolated') || m.onlyIsolated ? 'isolated' : 'cross'}` +
        `\n  stop ${px(sl)}${sl ? ` (${sgn(((sl - price) / price) * (isBuy ? 1 : -1) * notional - notional * PAPER_FEE_RATE * 2)})` : ''}   take profit ${px(tp)}${tp ? ` (${sgn(((tp - price) / price) * (isBuy ? 1 : -1) * notional - notional * PAPER_FEE_RATE * 2)})` : ''}` +
        `\n  fees ≈ ${usd(notional * PAPER_FEE_RATE)} per side (exchange 0.045% + SolMeme 0.035%)` +
        (chk.warnings.length ? '\n  ! ' + chk.warnings.join('\n  ! ') : '');
      if (!chk.ok) {
        console.log(plan + '\n\nREFUSED by your limits:\n  - ' + chk.problems.join('\n  - '));
        process.exit(4);
      }
      if (mode === 'paper') {
        const r = await paperOpen({ coin: m.coin, isBuy, size, leverage: lev, tp, sl });
        return out(`${plan}\n\nPAPER FILLED at ${px(r.px)} (fee ${usd(r.fee)}). Run "status" to follow it.`, { mode, ...r });
      }
      needConfirm(plan);
      const w = loadWallet();
      const r = await open(w, { coin: m.coin, isBuy, size, limitPx, leverage: lev, isCross: !has('isolated'), tp, sl });
      const st = statuses(r.res);
      const f = st[0]?.filled;
      const err = st.find((s) => s.error)?.error;
      appendJournal({ mode: 'live', action: 'open', coin: m.coin, label: m.label, side, size: f ? +f.totalSz : size, px: f ? +f.avgPx : price, leverage: lev, tp, sl, resting: !!st[0]?.resting, error: err, builder: !!r.builder });
      if (err && !f && !st[0]?.resting) throw new Error(err);
      return out(`${plan}\n\n${f ? `FILLED ${f.totalSz} at ${px(+f.avgPx)}` : st[0]?.resting ? `RESTING limit order #${st[0].resting.oid}` : 'SENT'}${err ? `\n  note: ${err}` : ''}${r.builder ? '' : '\n  (the SolMeme fee was not approved on this account; the order went without it)'}`, { mode, statuses: st });
    }

    case 'close': {
      const coin = sub ?? '';
      const p = num('pct') ?? 100;
      if (mode === 'paper') {
        const r = await paperClose(coin, p);
        return out(`PAPER CLOSED ${r.size.toPrecision(5)} ${r.market.label} at ${px(r.px)}: ${sgn(r.pnl)} after fees.`, { mode, ...r });
      }
      const m = await market(coin);
      needConfirm(`PLAN (LIVE): close ${p}% of the ${m.label} position at market.`);
      const w = loadWallet();
      const before = (await account(w.perps.address)).positions.find((x) => x.coin === m.coin);
      const r = await close(w, coin, p);
      const f = statuses(r.res)[0]?.filled;
      const pnl = before && f ? (+f.avgPx - before.entry) * +f.totalSz * (before.szi > 0 ? 1 : -1) - +f.totalSz * +f.avgPx * PAPER_FEE_RATE : undefined;
      appendJournal({ mode: 'live', action: 'close', coin: m.coin, label: m.label, side: before?.side, size: f ? +f.totalSz : undefined, px: f ? +f.avgPx : undefined, entry: before?.entry, pnl: pnl !== undefined ? +pnl.toFixed(2) : undefined, reason: 'manual close', leverage: before?.leverage });
      return out(`CLOSED ${f?.totalSz ?? ''} ${m.label} at ${px(f ? +f.avgPx : r.refPx)}${pnl !== undefined ? `: ${sgn(pnl)} (estimate after fees)` : ''}`, { mode, statuses: statuses(r.res) });
    }

    case 'tpsl': {
      const tp = num('tp');
      const sl = num('sl');
      if (!tp && !sl) throw new Error('Give --tp and/or --sl');
      if (mode === 'paper') {
        const p = await paperTpsl(sub ?? '', tp, sl);
        return out(`PAPER ${p.coin}: take profit ${px(p.tp)}, stop ${px(p.sl)}`, { mode, ...p });
      }
      const m = await market(sub ?? '');
      needConfirm(`PLAN (LIVE): set ${m.label} ${tp ? `take profit ${px(tp)} ` : ''}${sl ? `stop ${px(sl)}` : ''} on the whole position (replaces the old ones).`);
      const r = await setTpsl(loadWallet(), sub ?? '', tp, sl);
      appendJournal({ mode: 'live', action: 'tpsl', coin: m.coin, label: m.label, tp, sl });
      return out(`Set on ${r.market.label}: ${tp ? `take profit ${px(tp)} ` : ''}${sl ? `stop ${px(sl)}` : ''}`, { mode, statuses: statuses(r.res) });
    }

    case 'cancel': {
      if (mode === 'paper') return out('Paper mode has no resting orders (TP/SL live on the position: use tpsl).', { mode });
      needConfirm(`PLAN (LIVE): cancel ${sub ? `all ${sub} orders` : 'ALL open orders'} (including TP/SL triggers).`);
      const n = await cancelAll(loadWallet(), sub);
      appendJournal({ mode: 'live', action: 'cancel', coin: sub, count: n });
      return out(`Cancelled ${n} order(s).`, { cancelled: n });
    }

    case 'status': {
      if (mode === 'paper') {
        const a = await paperAccount();
        const lines = [
          `PAPER  equity ${usd(a.equity)} (start ${usd(a.state.start)}, ${sgn(a.equity - a.state.start)})  free ${usd(a.free)}  realized ${sgn(a.state.realized)}  fees paid ${usd(a.state.fees)}  today ${sgn(realizedToday('paper'))}`,
          ...a.events.map((e) => '  event: ' + e),
          a.positions.length
            ? table(a.positions.map((p) => [p.label, p.szi > 0 ? 'long' : 'short', Math.abs(p.szi).toPrecision(5), px(p.entry), px(p.mark), sgn(p.pnl), pct(p.roe, 1), px(p.liq), `${p.leverage}x`, px(p.tp ?? null), px(p.sl ?? null)]), ['market', 'side', 'size', 'entry', 'mark', 'pnl', 'roe', 'liq≈', 'lev', 'tp', 'sl'])
            : 'No open paper positions.',
        ];
        return out(lines.join('\n'), a);
      }
      const w = loadWallet();
      const [a, fee] = await Promise.all([account(w.perps.address), solmemeFee(w.solana)]);
      void registerBoard(w);
      const lines = [
        `LIVE  ${w.perps.address}\nequity ${usd(a.equity)}  withdrawable ${usd(a.withdrawable)}  margin used ${usd(a.marginUsed)}  today ${sgn(realizedToday('live'))}  SolMeme fee ${(fee / 1000).toFixed(3)}%`,
        a.spot.usol > 0.0005 ? `  ${a.spot.usol} SOL arrived from the bridge: run "sweep" to turn it into margin` : '',
        a.positions.length
          ? table(a.positions.map((p) => [p.coin.replace(/^xyz:/, ''), p.side, Math.abs(p.szi).toPrecision(5), px(p.entry), px(p.value / Math.abs(p.szi)), sgn(p.pnl), pct(p.roe, 1), px(p.liq), `${p.leverage}x ${p.isCross ? 'cross' : 'iso'}`]), ['market', 'side', 'size', 'entry', 'mark', 'pnl', 'roe', 'liq', 'lev'])
          : 'No open positions.',
        a.orders.length ? '\nOPEN ORDERS\n' + table(a.orders.map((o) => [o.coin.replace(/^xyz:/, ''), o.tpsl ?? o.type, o.side, o.sz || 'whole', px(o.triggerPx ?? o.px), String(o.oid)]), ['market', 'type', 'side', 'size', 'price', 'id']) : '',
      ].filter(Boolean);
      return out(lines.join('\n'), { ...a, feeTenthsBp: fee });
    }

    case 'journal': {
      const m = (str('mode') as 'paper' | 'live' | undefined) ?? mode;
      const all = readJournal().filter((e) => e.mode === m);
      const closes = all.filter((e) => e.action === 'close' && typeof e.pnl === 'number');
      const wins = closes.filter((e) => e.pnl > 0);
      const losses = closes.filter((e) => e.pnl <= 0);
      const sum = (xs: any[]) => xs.reduce((a, e) => a + e.pnl, 0);
      const pf = losses.length && sum(losses) !== 0 ? sum(wins) / -sum(losses) : null;
      const last = all.slice(-(num('limit') ?? 20));
      const text =
        `${m.toUpperCase()} JOURNAL  closed trades ${closes.length}  win rate ${closes.length ? ((wins.length / closes.length) * 100).toFixed(0) + '%' : '—'}  total ${sgn(sum(closes))}  avg win ${wins.length ? sgn(sum(wins) / wins.length) : '—'}  avg loss ${losses.length ? sgn(sum(losses) / losses.length) : '—'}  profit factor ${pf !== null ? pf.toFixed(2) : '—'}\n\n` +
        (last.length ? table(last.map((e) => [new Date(e.t).toISOString().slice(5, 16).replace('T', ' '), e.action, e.label ?? e.coin ?? '', e.side ?? '', e.size !== undefined ? Number(e.size).toPrecision(5) : '', e.px !== undefined ? px(e.px) : '', e.pnl !== undefined ? sgn(e.pnl) : '', e.reason ?? (e.sl ? `sl ${px(e.sl)} tp ${px(e.tp ?? null)}` : '')]), ['time (UTC)', 'action', 'market', 'side', 'size', 'price', 'pnl', 'note']) : 'Nothing yet.');
      return out(text, { mode: m, closed: closes.length, winRate: closes.length ? wins.length / closes.length : null, total: sum(closes), entries: last });
    }

    case 'profile': {
      const w = loadWallet();
      return out(`https://sol-meme.com/u/${w.solana}\nLive trades show on the SolMeme perps leaderboard (https://sol-meme.com/dex/leaderboard) and the profile has shareable PnL cards.`, { url: `https://sol-meme.com/u/${w.solana}` });
    }

    case 'fills': {
      const w = loadWallet();
      const f = (await fills(w.perps.address)).slice(0, num('limit') ?? 20);
      return out(table(f.map((x) => [new Date(x.time).toISOString().slice(5, 16).replace('T', ' '), x.coin, x.dir, x.sz, px(+x.px), sgn(+x.closedPnl), usd(+x.fee + +(x.builderFee ?? 0), 4)]), ['time (UTC)', 'market', 'direction', 'size', 'price', 'closed pnl', 'fees']), f);
    }

    case 'config': {
      const c = loadConfig();
      if (sub === 'mode') {
        const v = pos[2];
        if (v !== 'paper' && v !== 'live') throw new Error('config mode paper|live');
        if (v === 'live' && !hasWallet()) throw new Error('Create or import a wallet first.');
        c.mode = v;
      } else if (sub === 'auto') {
        c.autoConfirm = pos[2] === 'on';
      } else if (sub === 'set') {
        const k = pos[2] as keyof Config['limits'];
        const v = pos[3];
        if (!(k in DEFAULT_CONFIG.limits) || v === undefined) throw new Error(`config set <${Object.keys(DEFAULT_CONFIG.limits).join('|')}> <value>`);
        (c.limits as unknown as Record<string, number | boolean>)[k] = k === 'requireStop' ? v === 'true' || v === 'on' : Number(v);
      } else if (sub === 'ref') {
        c.ref = pos[2];
      } else if (sub === 'paper-reset') {
        resetPaper(Number(pos[2] ?? 1000));
        return console.log(`Paper account reset to ${usd(Number(pos[2] ?? 1000))}.`);
      } else if (sub && sub !== 'show') throw new Error('config show | mode | auto | set | ref | paper-reset');
      if (sub && sub !== 'show') saveConfig(c);
      return out(`mode ${c.mode}${c.autoConfirm ? ' (auto-confirm ON inside limits)' : ''}\nlimits ${Object.entries(c.limits).map(([k, v]) => `${k}=${v}`).join('  ')}${c.ref ? `\ninvite ${c.ref}` : ''}\nstate ${HOME}`, c);
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run "help".`);
  }
}

main().catch((e) => {
  console.error('ERROR: ' + friendlyError(e));
  process.exit(1);
});
