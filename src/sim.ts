import { book, candles, maintRate, market, TAKER_FEE } from './hl.js';
import { BUILDER } from './live.js';

/**
 * Time machine: replays the market's own recent behaviour thousands of times before you risk money.
 * Each path stitches random blocks of real 5-minute candles from the lookback window (block bootstrap keeps
 * volatility clustering), and checks every candle's high and low against take profit, stop loss and an
 * estimated liquidation price. It is a simulation of past volatility, not a forecast of direction.
 */
export interface SimInput {
  coin: string;
  side: 'long' | 'short';
  entry?: number;
  tp?: number;
  sl?: number;
  leverage: number;
  hours: number;
  paths: number;
  lookbackDays: number;
  notional?: number;
  /** keep the window's trend in the paths (by default only its volatility is replayed) */
  keepDrift?: boolean;
  /** keep this many sample paths (every 3rd step) in the result, for charts */
  dumpPaths?: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export async function simulate(o: SimInput) {
  const m = await market(o.coin);
  const now = Date.now();
  const ks = await candles(m.coin, '5m', now - o.lookbackDays * 864e5, now);
  if (ks.length < 200) throw new Error(`Not enough history for ${m.label} (${ks.length} candles).`);
  // each candle as moves relative to its open: close, high, low (log)
  const raw = ks.filter((k) => k.o > 0).map((k) => [Math.log(k.c / k.o), Math.log(k.h / k.o), Math.log(k.l / k.o)] as const);
  // remove the average drift of the window: keep its volatility and candle ranges, not its trend
  const drift = raw.reduce((a, x) => a + x[0], 0) / raw.length;
  const d = o.keepDrift ? 0 : drift;
  const moves = raw.map((x) => [x[0] - d, x[1] - d, x[2] - d] as const);
  // gaps between candles (close → next open) are tiny on a 24/7 market but kept for honesty
  const b = o.entry ? null : await book(m.coin);
  const entry = o.entry ?? (o.side === 'long' ? b!.ask : b!.bid);
  const long = o.side === 'long';
  const liq = long ? entry * (1 - (1 / o.leverage - maintRate(m))) : entry * (1 + (1 / o.leverage - maintRate(m)));
  const steps = Math.max(1, Math.round((o.hours * 60) / 5));
  const BLOCK = 12; // one hour of candles per block
  const rand = rng(now ^ (moves.length * 2654435761));
  const fee = TAKER_FEE + BUILDER.fee / 1e5;
  const notional = o.notional ?? 100;
  const funding = -(long ? 1 : -1) * m.funding * notional * o.hours;

  let tp = 0, sl = 0, lq = 0, open = 0;
  const tpTimes: number[] = [];
  const slTimes: number[] = [];
  const openRet: number[] = [];
  const sample: { o: 'tp' | 'sl' | 'liq' | 'open'; px: number[] }[] = [];
  for (let p = 0; p < o.paths; p++) {
    let lp = 0; // log price relative to entry
    let done = false;
    const keep = !!o.dumpPaths && p < o.dumpPaths;
    const trace: number[] = keep ? [entry] : [];
    let outcome: 'tp' | 'sl' | 'liq' | 'open' = 'open';
    let j = Math.floor(rand() * moves.length);
    for (let s = 0; s < steps; s++) {
      if (s % BLOCK === 0) j = Math.floor(rand() * (moves.length - BLOCK));
      const mv = moves[j + (s % BLOCK)] ?? moves[Math.floor(rand() * moves.length)]!;
      const hi = entry * Math.exp(lp + mv[1]);
      const lo = entry * Math.exp(lp + mv[2]);
      const adverse = long ? lo : hi;
      const favour = long ? hi : lo;
      const hitSl = o.sl !== undefined && (long ? adverse <= o.sl : adverse >= o.sl);
      const hitLiq = long ? adverse <= liq : adverse >= liq;
      const hitTp = o.tp !== undefined && (long ? favour >= o.tp : favour <= o.tp);
      if (hitSl && (!hitLiq || (long ? o.sl! > liq : o.sl! < liq))) {
        sl++;
        slTimes.push((s + 1) * 5);
        done = true;
        outcome = 'sl';
      } else if (hitLiq) {
        lq++;
        done = true;
        outcome = 'liq';
      } else if (hitTp) {
        tp++;
        tpTimes.push((s + 1) * 5);
        done = true;
        outcome = 'tp';
      }
      if (done) {
        if (keep) trace.push(outcome === 'tp' ? o.tp! : outcome === 'sl' ? o.sl! : liq);
        break;
      }
      lp += mv[0];
      if (keep && s % 3 === 2) trace.push(entry * Math.exp(lp));
    }
    if (keep) sample.push({ o: outcome, px: trace });
    if (!done) {
      open++;
      openRet.push(Math.exp(lp) - 1);
    }
  }
  const pct = (n: number) => (n / o.paths) * 100;
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null);
  const dir = long ? 1 : -1;
  const pnlAt = (px: number) => ((px - entry) / entry) * dir * notional - notional * fee * 2;
  const tpPnl = o.tp ? pnlAt(o.tp) : 0;
  const slPnl = o.sl ? pnlAt(o.sl) : 0;
  const liqPnl = -notional / o.leverage;
  const openPnls = openRet.map((r) => r * dir * notional - notional * fee * 2);
  const ev = (tp * tpPnl + sl * slPnl + lq * liqPnl + openPnls.reduce((a, x) => a + x, 0)) / o.paths + funding;
  // break-even win rate of this TP/SL pair after fees
  const be = o.tp && o.sl ? -slPnl / (tpPnl - slPnl) : null;
  const vol5m = Math.sqrt(moves.reduce((a, x) => a + x[0] * x[0], 0) / moves.length);
  const quant = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]! : 0);
  return {
    market: m,
    entry,
    liq,
    paths: o.paths,
    hours: o.hours,
    lookbackDays: o.lookbackDays,
    candlesUsed: moves.length,
    notional,
    probs: { tp: pct(tp), sl: pct(sl), liq: pct(lq), open: pct(open) },
    medianMinutes: { tp: med(tpTimes), sl: med(slTimes) },
    pnl: { tp: tpPnl, sl: slPnl, liq: liqPnl, openP10: quant(openPnls, 0.1), openP50: quant(openPnls, 0.5), openP90: quant(openPnls, 0.9), funding, expected: ev },
    breakEvenWinRate: be !== null ? be * 100 : null,
    dailyVolPct: vol5m * Math.sqrt(288) * 100,
    windowTrendPct: (Math.exp(drift * raw.length) - 1) * 100,
    sample,
    keptDrift: !!o.keepDrift,
  };
}
