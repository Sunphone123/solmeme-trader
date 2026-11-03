import { book, candles, maintRate, market, markets, TAKER_FEE, type Market } from './hl.js';
import { BUILDER } from './live.js';
import { appendJournal, PATHS, readJson, writeJson } from './store.js';

/**
 * Paper trading on live Hyperliquid prices: market fills at the real touch price, the same fees as live
 * (exchange taker + SolMeme builder), funding, and TP/SL/liquidation checked against real 1-minute candles
 * since the last check (if one candle crosses both TP and SL, the stop wins — the cautious assumption).
 */
export interface PaperPos {
  coin: string;
  szi: number;
  entry: number;
  leverage: number;
  tp?: number;
  sl?: number;
  openedAt: number;
  checkedAt: number;
  funding: number;
}
export interface PaperState {
  start: number;
  usdc: number;
  positions: PaperPos[];
  realized: number;
  fees: number;
}
const FEE = TAKER_FEE + BUILDER.fee / 1e5; // exchange 0.045% + SolMeme 0.035%
export const PAPER_FEE_RATE = FEE;

export const loadPaper = (): PaperState => readJson<PaperState>(PATHS.paper, { start: 1000, usdc: 1000, positions: [], realized: 0, fees: 0 });
const savePaper = (s: PaperState) => writeJson(PATHS.paper, s);

export function resetPaper(balance: number) {
  savePaper({ start: balance, usdc: balance, positions: [], realized: 0, fees: 0 });
}

const liqPx = (p: PaperPos, m: Market) => {
  // isolated-style estimate: margin 1/lev minus maintenance
  const d = 1 / p.leverage - maintRate(m);
  return p.szi > 0 ? p.entry * (1 - d) : p.entry * (1 + d);
};

function realize(s: PaperState, p: PaperPos, px: number, size: number, reason: string, m: Market) {
  const sign = p.szi > 0 ? 1 : -1;
  const pnl = (px - p.entry) * size * sign;
  const fee = Math.abs(size) * px * FEE;
  s.usdc += pnl - fee;
  s.realized += pnl - fee;
  s.fees += fee;
  appendJournal({ mode: 'paper', action: 'close', coin: m.coin, label: m.label, side: sign > 0 ? 'long' : 'short', size, px, entry: p.entry, pnl: +(pnl - fee).toFixed(2), reason, leverage: p.leverage });
  return pnl - fee;
}

/** walk real candles since the last check: TP, SL, liquidation, funding */
export async function tick(s: PaperState = loadPaper()): Promise<{ state: PaperState; events: string[] }> {
  const events: string[] = [];
  if (!s.positions.length) return { state: s, events };
  const all = await markets();
  const keep: PaperPos[] = [];
  for (const p of s.positions) {
    const m = all.find((x) => x.coin === p.coin);
    if (!m) {
      keep.push(p);
      continue;
    }
    const now = Date.now();
    const since = Math.max(p.checkedAt, now - 3 * 864e5);
    const ks = now - since > 60e3 ? await candles(m.coin, now - since > 2 * 864e5 ? '5m' : '1m', since, now).catch(() => []) : [];
    const long = p.szi > 0;
    const liq = liqPx(p, m);
    let closed = false;
    for (const k of ks) {
      const hitSl = p.sl !== undefined && (long ? k.l <= p.sl : k.h >= p.sl);
      const hitLiq = long ? k.l <= liq : k.h >= liq;
      const hitTp = p.tp !== undefined && (long ? k.h >= p.tp : k.l <= p.tp);
      // stop and liquidation first: the cautious order inside one candle
      if (hitSl && (!hitLiq || (long ? p.sl! > liq : p.sl! < liq))) {
        const r = realize(s, p, p.sl!, Math.abs(p.szi), 'stop loss', m);
        events.push(`${m.label}: stop loss hit at ${p.sl} (${r >= 0 ? '+' : ''}$${r.toFixed(2)})`);
        closed = true;
      } else if (hitLiq) {
        const r = realize(s, p, liq, Math.abs(p.szi), 'liquidation', m);
        events.push(`${m.label}: LIQUIDATED near ${liq.toPrecision(6)} (${r.toFixed(2)})`);
        closed = true;
      } else if (hitTp) {
        const r = realize(s, p, p.tp!, Math.abs(p.szi), 'take profit', m);
        events.push(`${m.label}: take profit hit at ${p.tp} (+$${r.toFixed(2)})`);
        closed = true;
      }
      if (closed) break;
    }
    if (closed) continue;
    // funding: longs pay positive funding, shorts receive it (hourly rate × hours × notional)
    const hours = (now - p.checkedAt) / 3600e3;
    const f = -Math.sign(p.szi) * m.funding * Math.abs(p.szi) * m.mark * hours;
    s.usdc += f;
    p.funding += f;
    p.checkedAt = now;
    keep.push(p);
  }
  s.positions = keep;
  savePaper(s);
  return { state: s, events };
}

export async function paperAccount() {
  const { state: s, events } = await tick();
  const all = await markets();
  const positions = s.positions.map((p) => {
    const m = all.find((x) => x.coin === p.coin)!;
    const pnl = (m.mark - p.entry) * p.szi;
    const value = Math.abs(p.szi) * m.mark;
    const margin = value / p.leverage;
    return { ...p, label: m.label, mark: m.mark, value, pnl, margin, roe: (pnl / ((Math.abs(p.szi) * p.entry) / p.leverage)) * 100, liq: liqPx(p, m) };
  });
  const unrealized = positions.reduce((a, p) => a + p.pnl, 0);
  const marginUsed = positions.reduce((a, p) => a + p.margin, 0);
  const equity = s.usdc + unrealized;
  return { state: s, events, positions, equity, unrealized, marginUsed, free: equity - marginUsed };
}

export async function paperOpen(o: { coin: string; isBuy: boolean; size: number; leverage: number; tp?: number; sl?: number }) {
  const { state: s } = await tick();
  const m = await market(o.coin);
  const b = await book(m.coin);
  const px = o.isBuy ? b.ask : b.bid;
  const notional = o.size * px;
  const acc = await paperAccount();
  const fee = notional * FEE;
  const cur = s.positions.find((p) => p.coin === m.coin);
  const adds = !cur || Math.sign(cur.szi) === (o.isBuy ? 1 : -1);
  if (adds && acc.free < notional / o.leverage + fee) throw new Error(`Not enough paper margin: need $${(notional / o.leverage + fee).toFixed(2)}, free $${acc.free.toFixed(2)}.`);
  const d = o.isBuy ? o.size : -o.size;
  if (!cur) {
    s.positions.push({ coin: m.coin, szi: d, entry: px, leverage: o.leverage, tp: o.tp, sl: o.sl, openedAt: Date.now(), checkedAt: Date.now(), funding: 0 });
    s.usdc -= fee;
    s.fees += fee;
  } else if (adds) {
    const n = cur.szi + d;
    cur.entry = (cur.entry * Math.abs(cur.szi) + px * o.size) / Math.abs(n);
    cur.szi = n;
    cur.leverage = o.leverage;
    if (o.tp) cur.tp = o.tp;
    if (o.sl) cur.sl = o.sl;
    s.usdc -= fee;
    s.fees += fee;
  } else {
    // opposite side: reduce, close or flip
    const closeSz = Math.min(Math.abs(cur.szi), o.size);
    realize(s, cur, px, closeSz, 'reduced by opposite order', m);
    const rest = o.size - closeSz;
    cur.szi += Math.sign(d) * closeSz;
    if (Math.abs(cur.szi) < 1e-12) s.positions = s.positions.filter((p) => p !== cur);
    if (rest > 1e-12) s.positions.push({ coin: m.coin, szi: Math.sign(d) * rest, entry: px, leverage: o.leverage, tp: o.tp, sl: o.sl, openedAt: Date.now(), checkedAt: Date.now(), funding: 0 });
  }
  savePaper(s);
  appendJournal({ mode: 'paper', action: 'open', coin: m.coin, label: m.label, side: o.isBuy ? 'long' : 'short', size: o.size, px, notional: +notional.toFixed(2), leverage: o.leverage, tp: o.tp, sl: o.sl, fee: +fee.toFixed(4) });
  return { px, notional, fee, market: m };
}

export async function paperClose(coin: string, pct = 100) {
  const { state: s } = await tick();
  const m = await market(coin);
  const p = s.positions.find((x) => x.coin === m.coin);
  if (!p) throw new Error(`No open paper ${m.label} position.`);
  const b = await book(m.coin);
  const px = p.szi > 0 ? b.bid : b.ask;
  const size = (Math.abs(p.szi) * Math.min(100, Math.max(1, pct))) / 100;
  const pnl = realize(s, p, px, size, 'manual close', m);
  p.szi -= Math.sign(p.szi) * size;
  if (Math.abs(p.szi) < 1e-12) s.positions = s.positions.filter((x) => x !== p);
  savePaper(s);
  return { px, size, pnl, market: m };
}

export async function paperTpsl(coin: string, tp?: number, sl?: number) {
  const { state: s } = await tick();
  const m = await market(coin);
  const p = s.positions.find((x) => x.coin === m.coin);
  if (!p) throw new Error(`No open paper ${m.label} position.`);
  if (tp !== undefined) p.tp = tp;
  if (sl !== undefined) p.sl = sl;
  savePaper(s);
  appendJournal({ mode: 'paper', action: 'tpsl', coin: m.coin, label: m.label, tp: p.tp, sl: p.sl });
  return p;
}
