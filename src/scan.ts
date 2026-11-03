import WebSocket from 'ws';
import { candles, fundingApr, market, markets, type Market } from './hl.js';

/** what moves, what is crowded, where the money is — from live Hyperliquid data */
export async function scan(opts: { minVolume: number; stocks: boolean; limit: number }) {
  const all = (await markets()).filter((m) => m.volume24h >= opts.minVolume && (opts.stocks || m.kind === 'crypto'));
  const by = (f: (m: Market) => number, dir = -1) => [...all].sort((a, b) => dir * (f(a) - f(b))).slice(0, opts.limit);
  return {
    count: all.length,
    gainers: by((m) => m.change24h),
    losers: by((m) => m.change24h, 1),
    fundingHigh: by((m) => m.funding),
    fundingLow: by((m) => m.funding, 1),
    // volume far above open interest: positions are turning over fast, a fresh move
    turnover: by((m) => (m.openInterestUsd > 0 ? m.volume24h / m.openInterestUsd : 0)),
    biggest: by((m) => m.volume24h),
  };
}

const ema = (xs: number[], n: number) => {
  const k = 2 / (n + 1);
  let e = xs[0] ?? 0;
  for (const x of xs) e = x * k + e * (1 - k);
  return e;
};

/** one market up close: trend, volatility, range, crowding */
export async function analyze(name: string) {
  const m = await market(name);
  const now = Date.now();
  const h1 = await candles(m.coin, '1h', now - 8 * 864e5, now);
  if (h1.length < 30) throw new Error(`Not enough history for ${m.label}`);
  const closes = h1.map((k) => k.c);
  const last = closes[closes.length - 1]!;
  const tr = h1.slice(1).map((k, i) => Math.max(k.h - k.l, Math.abs(k.h - h1[i]!.c), Math.abs(k.l - h1[i]!.c)));
  const atr = tr.slice(-14).reduce((a, x) => a + x, 0) / Math.min(14, tr.length);
  const d7 = h1.slice(-168);
  const hi7 = Math.max(...d7.map((k) => k.h));
  const lo7 = Math.min(...d7.map((k) => k.l));
  const d1 = h1.slice(-24);
  const hi1 = Math.max(...d1.map((k) => k.h));
  const lo1 = Math.min(...d1.map((k) => k.l));
  const e20 = ema(closes.slice(-60), 20);
  const e50 = ema(closes.slice(-150), 50);
  const ret = (n: number) => (closes.length > n ? (last / closes[closes.length - 1 - n]! - 1) * 100 : null);
  return {
    market: m,
    price: last,
    change: { h1: ret(1), h4: ret(4), h24: ret(24), d7: ret(168) },
    trend: e20 > e50 * 1.002 ? 'up' : e20 < e50 * 0.998 ? 'down' : 'flat',
    ema20: e20,
    ema50: e50,
    atr1h: atr,
    atrPct: (atr / last) * 100,
    range24h: { hi: hi1, lo: lo1, posPct: hi1 > lo1 ? ((last - lo1) / (hi1 - lo1)) * 100 : 50 },
    range7d: { hi: hi7, lo: lo7, posPct: hi7 > lo7 ? ((last - lo7) / (hi7 - lo7)) * 100 : 50 },
    fundingApr: fundingApr(m.funding),
    openInterestUsd: m.openInterestUsd,
    volume24h: m.volume24h,
  };
}

/**
 * Pulse: listen to the live trade stream of the busiest markets for a few seconds (the REST API keeps only
 * the last 10 trades), keep the big prints and the buy/sell balance, plus the most crowded funding.
 */
export async function pulse(opts: { minUsd: number; top: number; seconds: number; stocks: boolean }) {
  const all = await markets();
  const watch = all.filter((m) => m.kind === 'crypto').sort((a, b) => b.volume24h - a.volume24h).slice(0, opts.top);
  const big: { coin: string; side: 'buy' | 'sell'; usd: number; px: number; at: number }[] = [];
  const flow = new Map<string, { buy: number; sell: number; n: number }>();
  const label = new Map(watch.map((m) => [m.coin, m.label] as const));
  await new Promise<void>((resolve) => {
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    const done = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve();
    };
    const timer = setTimeout(done, opts.seconds * 1000);
    ws.on('open', () => {
      for (const m of watch) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: m.coin } }));
    });
    ws.on('message', (raw) => {
      let msg: { channel?: string; data?: { coin: string; side: 'B' | 'A'; px: string; sz: string; time: number }[] };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.channel !== 'trades' || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const usd = +t.px * +t.sz;
        const f = flow.get(t.coin) ?? { buy: 0, sell: 0, n: 0 };
        if (t.side === 'B') f.buy += usd;
        else f.sell += usd;
        f.n++;
        flow.set(t.coin, f);
        if (usd >= opts.minUsd) big.push({ coin: label.get(t.coin) ?? t.coin, side: t.side === 'B' ? 'buy' : 'sell', usd, px: +t.px, at: t.time });
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
  big.sort((a, b) => b.usd - a.usd);
  const balance = [...flow.entries()]
    .map(([coin, f]) => ({ coin: label.get(coin) ?? coin, buy: f.buy, sell: f.sell, net: f.buy - f.sell, trades: f.n, buyShare: f.buy + f.sell > 0 ? (f.buy / (f.buy + f.sell)) * 100 : 50 }))
    .filter((x) => x.buy + x.sell > 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 10);
  const crowded = all
    .filter((m) => m.volume24h > 2e6 && (opts.stocks || m.kind === 'crypto'))
    .sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
    .slice(0, 8);
  return { seconds: opts.seconds, watched: watch.map((m) => m.label), big: big.slice(0, 25), balance, crowded };
}
