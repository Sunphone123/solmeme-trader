import { maintRate, MIN_ORDER_USD, type Market } from './hl.js';
import { readJournal, type Config, type Mode } from './store.js';

/** realized PnL today (UTC) in this mode, from the journal */
export function realizedToday(mode: Mode) {
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return readJournal()
    .filter((e) => e.mode === mode && e.action === 'close' && e.t >= start && typeof e.pnl === 'number')
    .reduce((a, e) => a + e.pnl, 0);
}

export interface Check {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** hard limits from the config: the CLI refuses an order that breaks them, whatever the prompt says */
export function checkOpen(cfg: Config, mode: Mode, o: { market: Market; isBuy: boolean; notional: number; leverage: number; price: number; sl?: number; tp?: number; existingUsd: number }): Check {
  const L = cfg.limits;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (o.notional < MIN_ORDER_USD) problems.push(`Order is $${o.notional.toFixed(2)}; the exchange minimum is $${MIN_ORDER_USD}.`);
  if (o.notional > L.maxOrderUsd * 1.0005) problems.push(`Order is $${o.notional.toFixed(2)}; your limit per order is $${L.maxOrderUsd} (config limits.maxOrderUsd).`);
  if (o.existingUsd + o.notional > L.maxPositionUsd * 1.0005) problems.push(`${o.market.label} exposure would be $${(o.existingUsd + o.notional).toFixed(2)}; your limit per coin is $${L.maxPositionUsd}.`);
  if (o.leverage > L.maxLeverage) problems.push(`Leverage ${o.leverage}x is above your limit ${L.maxLeverage}x.`);
  if (o.leverage > o.market.maxLeverage) problems.push(`${o.market.label} allows at most ${o.market.maxLeverage}x.`);
  if (L.requireStop && !o.sl) problems.push('A stop loss is required (config limits.requireStop). Add --sl.');
  const lost = -realizedToday(mode);
  if (lost >= L.maxDailyLossUsd) problems.push(`Today's realized loss is $${lost.toFixed(2)}; your daily limit is $${L.maxDailyLossUsd}. No new positions until tomorrow (UTC).`);
  const long = o.isBuy;
  if (o.sl && (long ? o.sl >= o.price : o.sl <= o.price)) problems.push(`Stop ${o.sl} is on the wrong side of the price ${o.price} for a ${long ? 'long' : 'short'}.`);
  if (o.tp && (long ? o.tp <= o.price : o.tp >= o.price)) problems.push(`Take profit ${o.tp} is on the wrong side of the price ${o.price} for a ${long ? 'long' : 'short'}.`);
  if (o.sl) {
    const liq = long ? o.price * (1 - (1 / o.leverage - maintRate(o.market))) : o.price * (1 + (1 / o.leverage - maintRate(o.market)));
    if (long ? o.sl <= liq : o.sl >= liq) problems.push(`Stop ${o.sl} is beyond the estimated liquidation price ${liq.toPrecision(6)} at ${o.leverage}x. Lower the leverage or tighten the stop.`);
  }
  if (o.sl && o.tp) {
    const rr = Math.abs(o.tp - o.price) / Math.abs(o.price - o.sl);
    if (rr < 1) warnings.push(`Reward/risk is ${rr.toFixed(2)}: the stop is farther than the target.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

/** size from risk: lose riskUsd if the stop is hit (fees included) */
export function sizeFromRisk(price: number, sl: number, riskUsd: number, feeRate: number) {
  const perUnit = Math.abs(price - sl) + (price + sl) * feeRate;
  const size = riskUsd / perUnit;
  return { size, notional: size * price };
}
