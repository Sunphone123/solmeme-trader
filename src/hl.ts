/** Public Hyperliquid data: markets, prices, candles, order book, trades. No keys needed. */
const INFO = 'https://api.hyperliquid.xyz/info';

export async function info<T>(body: object): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      if (res.status === 429) throw new Error('Hyperliquid rate limit');
      if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface Market {
  /** engine name: "BTC", HIP-3 markets carry the dex prefix ("xyz:TSLA") */
  coin: string;
  /** what people call it: no prefix */
  label: string;
  /** '' main exchange, 'xyz' stocks, indices and commodities */
  dex: string;
  kind: 'crypto' | 'stock';
  onlyIsolated: boolean;
  /** asset id for orders: main = index, HIP-3 = 100000 + dexIndex × 10000 + index */
  asset: number;
  maxLeverage: number;
  szDecimals: number;
  mark: number;
  mid: number | null;
  prevDay: number;
  change24h: number;
  volume24h: number;
  openInterestUsd: number;
  /** hourly funding rate as a fraction */
  funding: number;
}

type Meta = { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean; marginMode?: string }[] };
type Ctx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; markPx: string; midPx: string | null };

export const DEXES = ['', 'xyz'];

function toMarkets(meta: Meta, ctxs: Ctx[], dex: string, idx: number): Market[] {
  const out: Market[] = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted) return;
    const mark = Number(c.markPx);
    if (!(mark > 0)) return;
    const prev = Number(c.prevDayPx);
    out.push({
      coin: u.name,
      label: dex ? u.name.slice(dex.length + 1) : u.name,
      dex,
      kind: dex ? 'stock' : 'crypto',
      onlyIsolated: !!u.onlyIsolated || u.marginMode === 'noCross' || u.marginMode === 'strictIsolated',
      asset: dex ? 100000 + idx * 10000 + i : i,
      maxLeverage: u.maxLeverage,
      szDecimals: u.szDecimals,
      mark,
      mid: c.midPx ? Number(c.midPx) : null,
      prevDay: prev,
      change24h: prev > 0 ? ((mark - prev) / prev) * 100 : 0,
      volume24h: Number(c.dayNtlVlm),
      openInterestUsd: Number(c.openInterest) * mark,
      funding: Number(c.funding),
    });
  });
  return out;
}

let cache: { at: number; list: Market[] } | null = null;
export async function markets(): Promise<Market[]> {
  if (cache && Date.now() - cache.at < 5000) return cache.list;
  const [main, dexs, ...extra] = await Promise.all([
    info<[Meta, Ctx[]]>({ type: 'metaAndAssetCtxs' }),
    info<({ name: string } | null)[]>({ type: 'perpDexs' }).catch(() => [] as ({ name: string } | null)[]),
    ...DEXES.filter(Boolean).map((dex) => info<[Meta, Ctx[]]>({ type: 'metaAndAssetCtxs', dex }).catch(() => null)),
  ]);
  const idx = new Map(dexs.map((d, i) => [d?.name ?? '', i] as const).filter(([n]) => n));
  const list = toMarkets(main[0], main[1], '', 0);
  DEXES.filter(Boolean).forEach((dex, k) => {
    const r = extra[k];
    const i = idx.get(dex);
    if (r && i !== undefined) list.push(...toMarkets(r[0], r[1], dex, i));
  });
  cache = { at: Date.now(), list };
  return list;
}

/** "btc", "BTC", "tsla", "xyz:TSLA" → market */
export async function market(name: string): Promise<Market> {
  const n = name.trim().toUpperCase().replace(/-PERP$|-USD$|USDT$/, '');
  const list = await markets();
  const m = list.find((x) => x.coin.toUpperCase() === n) ?? list.find((x) => x.label.toUpperCase() === n);
  if (!m) throw new Error(`Unknown market "${name}". Run "markets" to see what trades.`);
  return m;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export const STEP_MS: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
export async function candles(coin: string, interval: string, startTime: number, endTime = Date.now()): Promise<Candle[]> {
  const out: Candle[] = [];
  let from = startTime;
  // the API returns at most 5000 candles per call
  for (let guard = 0; guard < 10 && from < endTime; guard++) {
    const raw = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: 'candleSnapshot', req: { coin, interval, startTime: from, endTime } });
    if (!raw.length) break;
    for (const k of raw) if (!out.length || k.t > out[out.length - 1]!.t) out.push({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
    const lastT = raw[raw.length - 1]!.t;
    if (raw.length < 4900) break;
    from = lastT + (STEP_MS[interval] ?? 60e3);
  }
  return out;
}

export async function book(coin: string): Promise<{ bid: number; ask: number; bids: [number, number][]; asks: [number, number][] }> {
  const b = await info<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: 'l2Book', coin });
  const bids = b.levels[0].map((l) => [+l.px, +l.sz] as [number, number]);
  const asks = b.levels[1].map((l) => [+l.px, +l.sz] as [number, number]);
  if (!bids.length || !asks.length) throw new Error(`No liquidity in the ${coin} order book right now`);
  return { bid: bids[0]![0], ask: asks[0]![0], bids, asks };
}

export async function recentTrades(coin: string) {
  return info<{ coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; hash: string }[]>({ type: 'recentTrades', coin });
}

export const fundingApr = (hourly: number) => hourly * 24 * 365 * 100;
/** taker fee of the exchange itself (base tier) */
export const TAKER_FEE = 0.00045;
export const MIN_ORDER_USD = 10;
/** maintenance margin rate: half of the initial margin at max leverage */
export const maintRate = (m: Market) => 1 / (2 * m.maxLeverage);
