import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { existsSync } from 'node:fs';
import { PATHS, readJson, writeJson } from './store.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
export function b58decode(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not a base58 string');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** secp256k1 group order: the key must be in [1, n−1] */
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/**
 * Perps key from the Solana wallet key — the same rule as sol-meme.com, so the same wallet
 * opens the same perps account here and in the SolMeme terminal.
 */
export function derivePerpsKey(secret: Uint8Array): `0x${string}` {
  const tag = new TextEncoder().encode('solmeme:perps:v1');
  for (let i = 0; i < 8; i++) {
    const h = createHash('sha512').update(Buffer.from([...tag, i, ...secret])).digest().subarray(0, 32);
    const hex = h.toString('hex');
    const k = BigInt(`0x${hex}`);
    if (k > 0n && k < SECP_N) return `0x${hex}`;
  }
  throw new Error('Could not derive the perps key');
}

export interface Wallet {
  /** Solana wallet: same as the SolMeme instant wallet when imported from the site */
  solana: string;
  secret: Uint8Array;
  perps: PrivateKeyAccount;
}

type Stored = { secret: string; createdAt: number; source: 'created' | 'imported' };

export const hasWallet = () => existsSync(PATHS.wallet);

export function loadWallet(): Wallet {
  const s = readJson<Stored | null>(PATHS.wallet, null);
  if (!s?.secret) throw new Error('No wallet yet. Run "wallet create" or "wallet import" first.');
  const secret = b58decode(s.secret);
  if (secret.length !== 64) throw new Error('The stored wallet key is damaged (expected 64 bytes).');
  const kp = nacl.sign.keyPair.fromSecretKey(secret);
  return { solana: b58encode(kp.publicKey), secret, perps: privateKeyToAccount(derivePerpsKey(secret)) };
}

export function createWallet(): Wallet {
  if (hasWallet()) throw new Error(`A wallet already exists in ${PATHS.wallet}. Remove it first if you really want a new one.`);
  const kp = nacl.sign.keyPair();
  writeJson(PATHS.wallet, { secret: b58encode(kp.secretKey), createdAt: Date.now(), source: 'created' } satisfies Stored, true);
  return loadWallet();
}

/** accepts a base58 secret (Phantom/SolMeme export) or a JSON byte array (solana-keygen file) */
export function importWallet(raw: string): Wallet {
  if (hasWallet()) throw new Error(`A wallet already exists in ${PATHS.wallet}. Remove it first to import another one.`);
  const v = raw.trim();
  let bytes: Uint8Array;
  if (v.startsWith('[')) bytes = Uint8Array.from(JSON.parse(v) as number[]);
  else bytes = b58decode(v);
  if (bytes.length !== 64) throw new Error('A Solana private key is 64 bytes. Paste the full key exported from SolMeme or Phantom.');
  nacl.sign.keyPair.fromSecretKey(bytes);
  writeJson(PATHS.wallet, { secret: b58encode(bytes), createdAt: Date.now(), source: 'imported' } satisfies Stored, true);
  return loadWallet();
}

export function signSolana(w: Wallet, message: Uint8Array) {
  return nacl.sign.detached(message, w.secret);
}
