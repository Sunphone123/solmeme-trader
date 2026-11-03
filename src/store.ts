import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** All local state lives in ~/.solmeme (override with SOLMEME_HOME). Nothing here is ever sent anywhere. */
export const HOME = process.env.SOLMEME_HOME || join(homedir(), '.solmeme');
export const PATHS = {
  wallet: join(HOME, 'wallet.json'),
  config: join(HOME, 'config.json'),
  paper: join(HOME, 'paper.json'),
  journal: join(HOME, 'journal.jsonl'),
  live: join(HOME, 'live.json'),
};

function ensureHome() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, data: unknown, secret = false) {
  ensureHome();
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
}

export function appendJournal(entry: Record<string, unknown>) {
  ensureHome();
  appendFileSync(PATHS.journal, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
}

export function readJournal(): Record<string, any>[] {
  try {
    return readFileSync(PATHS.journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export type Mode = 'paper' | 'live';
export interface Limits {
  /** largest notional of one new order, $ */
  maxOrderUsd: number;
  /** largest total notional per coin, $ */
  maxPositionUsd: number;
  maxLeverage: number;
  /** no new positions after this much realized loss today (UTC), $ */
  maxDailyLossUsd: number;
  /** every new position must carry a stop loss */
  requireStop: boolean;
  /** default risk per trade for sizing, % of equity */
  riskPerTradePct: number;
}
export interface Config {
  mode: Mode;
  /** live orders without asking the user each time, still inside the limits */
  autoConfirm: boolean;
  limits: Limits;
  /** invite: Solana wallet of the person who referred this trader (lower fee for the trader) */
  ref?: string;
  /** Solana RPC for deposits (the bridge transfer); default is a public keyless node */
  solanaRpc?: string;
}
export const DEFAULT_CONFIG: Config = {
  mode: 'paper',
  autoConfirm: false,
  limits: { maxOrderUsd: 100, maxPositionUsd: 200, maxLeverage: 5, maxDailyLossUsd: 25, requireStop: true, riskPerTradePct: 1 },
};
export function loadConfig(): Config {
  const c = readJson<Partial<Config>>(PATHS.config, {});
  return { ...DEFAULT_CONFIG, ...c, limits: { ...DEFAULT_CONFIG.limits, ...(c.limits ?? {}) } };
}
export const saveConfig = (c: Config) => writeJson(PATHS.config, c);
