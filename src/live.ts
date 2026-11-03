import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { randomBytes } from 'node:crypto';
import { book, DEXES, info, market, markets, MIN_ORDER_USD, type Market } from './hl.js';
import type { Wallet } from './keys.js';
import { loadConfig, PATHS, readJson, writeJson } from './store.js';

/** SolMeme builder: our fee on every order goes to this account (tenths of a basis point: 35 = 0.035%) */
export const BUILDER = { address: '0x48B57798e2d58BF2c73f62951931184B5150f218' as `0x${string}`, fee: 35 };
export const SOLMEME_API = process.env.SOLMEME_API || 'https://sol-meme.com/api';
/** market orders: worst fill price from the touch, like the Hyperliquid frontend */
export const SLIPPAGE = 0.03;
/** client order ids start with "SolMemeSkill" so skill orders are recognisable in fills */
const CLOID_PREFIX = '536f6c4d656d65536b696c6c';
const cloid = () => `0x${CLOID_PREFIX}${randomBytes(4).toString('hex')}` as `0x${string}`;

type Clearinghouse = {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      liquidationPx: string | null;
      marginUsed: string;
      leverage: { type: 'cross' | 'isolated'; value: number };
      cumFunding: { sinceOpen: string };
    };
  }[];
};
type Oo = { coin: string; side: 'B' | 'A'; limitPx: string; sz: string; oid: number; timestamp: number; orderType: string; reduceOnly: boolean; isTrigger: boolean; triggerPx: string; isPositionTpsl?: boolean };

export interface Position {
  coin: string;
  szi: number;
  side: 'long' | 'short';
  entry: number;
  value: number;
  pnl: number;
  roe: number;
  liq: number | null;
  margin: number;
  leverage: number;
  isCross: boolean;
  funding: number;
}
export interface OpenOrder {
  coin: string;
  oid: number;
  side: 'buy' | 'sell';
  px: number;
  sz: number;
  type: string;
  reduceOnly: boolean;
  triggerPx: number | null;
  tpsl: 'tp' | 'sl' | null;
}
export interface Account {
  address: string;
  equity: number;
  withdrawable: number;
  marginUsed: number;
  freeByDex: Record<string, number>;
  positions: Position[];
  orders: OpenOrder[];
  spot: { usdc: number; usol: number };
}

export async function account(address: string): Promise<Account> {
  const [chs, oos, sp] = await Promise.all([
    Promise.all(DEXES.map((dex) => info<Clearinghouse>({ type: 'clearinghouseState', user: address, dex }))),
    Promise.all(DEXES.map((dex) => info<Oo[]>({ type: 'frontendOpenOrders', user: address, dex }).catch(() => [] as Oo[]))),
    info<{ balances: { coin: string; total: string; hold: string }[] }>({ type: 'spotClearinghouseState', user: address }),
  ]);
  const sum = (f: (c: Clearinghouse) => number) => chs.reduce((a, c) => a + f(c), 0);
  const bal = (c: string) => sp.balances.find((b) => b.coin === c);
  const positions = chs
    .flatMap((c) => c.assetPositions)
    .map(({ position: p }) => ({
      coin: p.coin,
      szi: +p.szi,
      side: (+p.szi >= 0 ? 'long' : 'short') as 'long' | 'short',
      entry: +p.entryPx,
      value: +p.positionValue,
      pnl: +p.unrealizedPnl,
      roe: +p.returnOnEquity * 100,
      liq: p.liquidationPx ? +p.liquidationPx : null,
      margin: +p.marginUsed,
      leverage: p.leverage.value,
      isCross: p.leverage.type === 'cross',
      funding: -+p.cumFunding.sinceOpen,
    }))
    .filter((p) => p.szi !== 0);
  const orders = oos.flat().map((o) => ({
    coin: o.coin,
    oid: o.oid,
    side: (o.side === 'B' ? 'buy' : 'sell') as 'buy' | 'sell',
    px: +o.limitPx,
    sz: +o.sz,
    type: o.orderType,
    reduceOnly: o.reduceOnly,
    triggerPx: o.isTrigger ? +o.triggerPx : null,
    tpsl: (/take profit/i.test(o.orderType) ? 'tp' : /stop/i.test(o.orderType) ? 'sl' : null) as 'tp' | 'sl' | null,
  }));
  return {
    address,
    equity: sum((c) => +c.marginSummary.accountValue),
    withdrawable: sum((c) => +c.withdrawable),
    marginUsed: sum((c) => +c.marginSummary.totalMarginUsed),
    freeByDex: Object.fromEntries(DEXES.map((d, i) => [d, +chs[i]!.withdrawable])),
    positions,
    orders: orders.filter((o) => !o.coin.startsWith('@') && !o.coin.includes('/')),
    spot: { usdc: +(bal('USDC')?.total ?? 0) - +(bal('USDC')?.hold ?? 0), usol: +(bal('USOL')?.total ?? 0) - +(bal('USOL')?.hold ?? 0) },
  };
}

// ---------- SolMeme: fee for this wallet and the perps leaderboard ----------

/** our fee for this wallet: 32 (0.032%) for invited traders, otherwise 35 */
export async function solmemeFee(solana: string): Promise<number> {
  const ref = loadConfig().ref ?? '';
  try {
    const res = await fetch(`${SOLMEME_API}/terminal/perps-fee?wallet=${solana}&ref=${ref}`, { signal: AbortSignal.timeout(8000) });
    const f = Math.round(Number(((await res.json()) as { fee: number }).fee));
    return f > 0 && f <= BUILDER.fee ? f : BUILDER.fee;
  } catch {
    return BUILDER.fee;
  }
}

type LiveState = { builderOk?: boolean; boardAt?: number; boardKey?: string };
const state = () => readJson<LiveState>(PATHS.live, {});
const saveState = (s: LiveState) => writeJson(PATHS.live, s);

/**
 * Show this account on the SolMeme perps leaderboard under the Solana wallet. The server cannot derive
 * perps accounts, so we tell it which account belongs to which wallet, signed by the account key. Weekly.
 */
export async function registerBoard(w: Wallet) {
  const acc = w.perps.address.toLowerCase();
  const ref = loadConfig().ref;
  const key = `${acc}:${w.solana}:${ref ?? ''}`;
  const s = state();
  if (s.boardKey === key && Date.now() - (s.boardAt ?? 0) < 7 * 864e5) return;
  try {
    const signature = await w.perps.signMessage({ message: `SolMeme leaderboard\nPerps account: ${acc}\nWallet: ${w.solana}` });
    const res = await fetch(`${SOLMEME_API}/terminal/perps-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: acc, wallet: w.solana, signature, ...(ref && ref !== w.solana ? { ref } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) saveState({ ...state(), boardAt: Date.now(), boardKey: key });
  } catch {
    // the leaderboard can wait for the next trade
  }
}

// ---------- trading ----------

export function client(w: Wallet) {
  return new ExchangeClient({ transport: new HttpTransport(), wallet: w.perps });
}
type Ex = ReturnType<typeof client>;

/** approve our builder fee once per account; if the exchange refuses, orders go without it instead of failing */
async function ensureBuilder(w: Wallet, ex: Ex): Promise<{ b: `0x${string}`; f: number } | undefined> {
  const s = state();
  const f = await solmemeFee(w.solana);
  try {
    if (!s.builderOk) {
      const max = await info<number>({ type: 'maxBuilderFee', user: w.perps.address, builder: BUILDER.address }).catch(() => 0);
      if (max < BUILDER.fee) await ex.approveBuilderFee({ maxFeeRate: `${BUILDER.fee / 1000}%`, builder: BUILDER.address });
      saveState({ ...state(), builderOk: true });
    }
    return { b: BUILDER.address, f };
  } catch {
    return undefined;
  }
}

async function orderWithBuilder(ex: Ex, params: Parameters<Ex['order']>[0]) {
  try {
    return await ex.order(params);
  } catch (e) {
    if (!params.builder || !/builder/i.test(e instanceof Error ? e.message : String(e))) throw e;
    saveState({ ...state(), builderOk: false });
    return ex.order({ ...params, builder: undefined });
  }
}

export function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/insufficient margin/i.test(m)) return 'Not enough margin for this order. Deposit more or lower the size.';
  if (/minimum value/i.test(m)) return `The order is too small. The minimum is $${MIN_ORDER_USD}.`;
  if (/does not exist/i.test(m)) return 'This perps account has no deposit yet. Run "deposit-address" and send SOL first.';
  if (/reduce only/i.test(m)) return 'A reduce-only order would open a new position.';
  return m.slice(0, 300);
}

async function ensureLeverage(ex: Ex, m: Market, leverage: number, isCross: boolean, address: string) {
  const d = await info<{ leverage?: { type: 'cross' | 'isolated'; value: number } }>({ type: 'activeAssetData', user: address, coin: m.coin }).catch(() => null);
  const l = d?.leverage;
  if (l && l.value === leverage && (l.type === 'cross') === isCross) return;
  await ex.updateLeverage({ asset: m.asset, isCross, leverage });
}

/** each dex keeps its own USDC: move missing margin from the other one before an order (main ⇄ xyz) */
async function ensureDexMargin(ex: Ex, a: Account, dex: string, need: number) {
  const free = a.freeByDex[dex] ?? 0;
  if (free >= need) return;
  let missing = need - free;
  for (const other of DEXES) {
    if (other === dex || missing <= 0) continue;
    const take = Math.min(Math.floor((a.freeByDex[other] ?? 0) * 100) / 100, Math.ceil(missing * 100) / 100);
    if (take < 0.01) continue;
    await ex.sendAsset({ destination: a.address as `0x${string}`, sourceDex: other, destinationDex: dex, token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: take.toFixed(2) });
    missing -= take;
  }
  if (missing > 0.01) throw new Error('Not enough margin for this order. Deposit more or lower the size.');
}

type Status = { filled?: { totalSz: string; avgPx: string; oid: number }; resting?: { oid: number }; error?: string };
export const statuses = (res: unknown) => ((res as { response?: { data?: { statuses?: Status[] } } }).response?.data?.statuses ?? []) as Status[];

export interface OpenInput {
  coin: string;
  isBuy: boolean;
  size: number;
  limitPx?: number;
  leverage: number;
  isCross: boolean;
  tp?: number;
  sl?: number;
  reduceOnly?: boolean;
}

export async function open(w: Wallet, o: OpenInput) {
  const ex = client(w);
  const m = await market(o.coin);
  const builder = await ensureBuilder(w, ex);
  await ensureLeverage(ex, m, o.leverage, o.isCross && !m.onlyIsolated, w.perps.address);
  const isMarket = !o.limitPx;
  const b = await book(m.coin);
  const ref = isMarket ? (o.isBuy ? b.ask : b.bid) : o.limitPx!;
  const a = await account(w.perps.address);
  if (!o.reduceOnly) await ensureDexMargin(ex, a, m.dex, (o.size * ref) / o.leverage + o.size * ref * 0.002);
  const px = isMarket ? ref * (o.isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE) : ref;
  const sz = formatSize(o.size, m.szDecimals);
  if (+sz * ref < MIN_ORDER_USD && !o.reduceOnly) throw new Error(`The order is too small. The minimum is $${MIN_ORDER_USD}.`);
  const trig = (kind: 'tp' | 'sl', at: number) => ({
    a: m.asset,
    b: !o.isBuy,
    p: formatPrice(at * (o.isBuy ? 1 - SLIPPAGE : 1 + SLIPPAGE), m.szDecimals),
    s: sz,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: formatPrice(at, m.szDecimals), tpsl: kind } },
    c: cloid(),
  });
  const orders = [
    { a: m.asset, b: o.isBuy, p: formatPrice(px, m.szDecimals), s: sz, r: !!o.reduceOnly, t: { limit: { tif: isMarket ? ('FrontendMarket' as const) : ('Gtc' as const) } }, c: cloid() },
    ...(o.tp ? [trig('tp', o.tp)] : []),
    ...(o.sl ? [trig('sl', o.sl)] : []),
  ];
  const res = await orderWithBuilder(ex, { orders, grouping: o.tp || o.sl ? 'normalTpsl' : 'na', builder });
  void registerBoard(w);
  return { res, market: m, refPx: ref, builder };
}

export async function close(w: Wallet, coin: string, pct = 100) {
  const ex = client(w);
  const m = await market(coin);
  const a = await account(w.perps.address);
  const p = a.positions.find((x) => x.coin === m.coin);
  if (!p) throw new Error(`No open ${m.label} position.`);
  const isBuy = p.szi < 0;
  const b = await book(m.coin);
  const ref = isBuy ? b.ask : b.bid;
  const size = (Math.abs(p.szi) * Math.min(100, Math.max(1, pct))) / 100;
  const builder = await ensureBuilder(w, ex);
  const res = await orderWithBuilder(ex, {
    orders: [{ a: m.asset, b: isBuy, p: formatPrice(ref * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), m.szDecimals), s: formatSize(size, m.szDecimals), r: true, t: { limit: { tif: 'FrontendMarket' } }, c: cloid() }],
    grouping: 'na',
    builder,
  });
  // TP/SL of a fully closed position stay behind as orphan triggers — remove them
  if (pct >= 100) {
    const left = a.orders.filter((o) => o.coin === m.coin && o.triggerPx !== null);
    if (left.length) await ex.cancel({ cancels: left.map((o) => ({ a: m.asset, o: o.oid })) }).catch(() => {});
  }
  return { res, market: m, position: p, refPx: ref };
}

/** replace TP/SL on the whole position */
export async function setTpsl(w: Wallet, coin: string, tp?: number, sl?: number) {
  const ex = client(w);
  const m = await market(coin);
  const a = await account(w.perps.address);
  const p = a.positions.find((x) => x.coin === m.coin);
  if (!p) throw new Error(`No open ${m.label} position.`);
  const isBuy = p.szi < 0;
  const old = a.orders.filter((o) => o.coin === m.coin && o.triggerPx !== null && ((tp && o.tpsl === 'tp') || (sl && o.tpsl === 'sl')));
  if (old.length) await ex.cancel({ cancels: old.map((o) => ({ a: m.asset, o: o.oid })) });
  const sz = formatSize(Math.abs(p.szi), m.szDecimals);
  const trig = (kind: 'tp' | 'sl', at: number) => ({
    a: m.asset,
    b: isBuy,
    p: formatPrice(at * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), m.szDecimals),
    s: sz,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: formatPrice(at, m.szDecimals), tpsl: kind } },
    c: cloid(),
  });
  const list = [...(tp ? [trig('tp', tp)] : []), ...(sl ? [trig('sl', sl)] : [])];
  if (!list.length) throw new Error('Give --tp and/or --sl');
  const builder = await ensureBuilder(w, ex);
  const res = await orderWithBuilder(ex, { orders: list, grouping: 'positionTpsl', builder });
  return { res, market: m, position: p };
}

export async function cancelAll(w: Wallet, coin?: string) {
  const ex = client(w);
  const a = await account(w.perps.address);
  const all = await markets();
  const list = a.orders.filter((o) => !coin || o.coin.toUpperCase() === coin.toUpperCase() || o.coin.toUpperCase().endsWith(':' + coin.toUpperCase()));
  if (!list.length) return 0;
  const cancels = list.map((o) => ({ a: all.find((m) => m.coin === o.coin)!.asset, o: o.oid }));
  await ex.cancel({ cancels });
  return list.length;
}

export async function fills(address: string) {
  return info<{ coin: string; px: string; sz: string; side: 'B' | 'A'; dir: string; closedPnl: string; fee: string; builderFee?: string; time: number; cloid?: string }[]>({ type: 'userFills', user: address });
}
