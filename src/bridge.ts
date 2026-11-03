import { webcrypto } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { formatPrice } from '@nktkas/hyperliquid/utils';
import { book, DEXES, info, MIN_ORDER_USD } from './hl.js';
import { account, client, SLIPPAGE } from './live.js';
import type { Wallet } from './keys.js';
import { loadConfig } from './store.js';

/**
 * Unit (Hyperunit) bridges SOL between Solana and Hyperliquid: SOL sent to the deposit address arrives as USOL,
 * USOL sent to the withdraw address arrives back as SOL. Every address is signed by Unit guardians; we verify
 * 2 of 3 signatures locally, so a forged API answer cannot redirect funds.
 */
const API = 'https://api.hyperunit.xyz';
const GUARDIANS: Record<string, string> = {
  'unit-node': '04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061',
  'hl-node': '048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b',
  'field-node': '04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99',
};
export const UNIT_MIN_SOL = 0.12;
const USOL = { token: 'USOL:0x49b67c39f5566535de22b29b0e51e685', pair: '@156', asset: 10156, szDecimals: 3 } as const;
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function verified(msgFor: (node: string) => string, sigs: Record<string, string>) {
  let ok = 0;
  for (const [node, pub] of Object.entries(GUARDIANS)) {
    const sig = sigs[node];
    if (!sig) continue;
    try {
      const key = await webcrypto.subtle.importKey('raw', hexBytes(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64'), new TextEncoder().encode(msgFor(node)))) ok++;
    } catch {
      // a bad signature simply does not count
    }
  }
  return ok >= 2;
}

export async function unitAddress(kind: 'deposit' | 'withdraw', dst: string): Promise<string> {
  const [src, dstChain, format] = kind === 'deposit' ? ['solana', 'hyperliquid', 'solana'] : ['hyperliquid', 'solana', 'ethereum'];
  const res = await fetch(`${API}/gen/${src}/${dstChain}/sol/${dst}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('The bridge did not answer. Try again in a minute.');
  const data = (await res.json()) as { address?: string; signatures?: Record<string, string> };
  if (!data.address || !data.signatures) throw new Error('The bridge returned no address');
  if (!(await verified((node) => `${node}:user-${format}-${dstChain}-${dst}-${data.address}`, data.signatures))) throw new Error('The bridge address failed the guardian check. Nothing was sent.');
  return data.address;
}

const rpc = () => new Connection(loadConfig().solanaRpc || process.env.SOLMEME_SOLANA_RPC || 'https://solana-rpc.publicnode.com', 'confirmed');

export async function solBalance(addr: string) {
  return (await rpc().getBalance(new PublicKey(addr))) / 1e9;
}

/** send SOL from this wallet on Solana to the verified Unit deposit address of the perps account */
export async function depositSol(w: Wallet, sol: number) {
  if (!(sol >= UNIT_MIN_SOL)) throw new Error(`The bridge needs at least ${UNIT_MIN_SOL} SOL`);
  const to = await unitAddress('deposit', w.perps.address);
  const conn = rpc();
  const kp = Keypair.fromSecretKey(w.secret);
  const bal = (await conn.getBalance(kp.publicKey)) / 1e9;
  if (bal < sol + 0.001) throw new Error(`The wallet has ${bal.toFixed(4)} SOL; keep about 0.001 SOL for the network fee.`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * 1e9) }));
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return { sig, to };
}

/** deposited SOL arrives as USOL on the spot balance: sell it for USDC and move the USDC to perps */
export async function sweep(w: Wallet) {
  const ex = client(w);
  const mode = await info<string>({ type: 'userAbstraction', user: w.perps.address }).catch(() => '');
  if (mode && mode !== 'disabled') await ex.userSetAbstraction({ user: w.perps.address, abstraction: 'disabled' });
  const a = await account(w.perps.address);
  const usol = Math.floor(a.spot.usol * 1000) / 1000;
  if (!(usol > 0)) return { sold: 0, usdc: 0 };
  const b = await book(USOL.pair);
  if (usol * b.bid < MIN_ORDER_USD) throw new Error(`Need at least $${MIN_ORDER_USD} of SOL to convert (have ${usol} SOL).`);
  const before = a.spot.usdc;
  await ex.order({ orders: [{ a: USOL.asset, b: false, p: formatPrice(b.bid * (1 - SLIPPAGE), USOL.szDecimals, 'spot'), s: usol.toFixed(3), r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
  const after = (await account(w.perps.address)).spot.usdc;
  const gained = after - before;
  if (gained >= 1) await ex.usdClassTransfer({ amount: (Math.floor(gained * 100) / 100).toFixed(2), toPerp: true });
  return { sold: usol, usdc: gained };
}

/** USDC from perps → USOL → Unit withdraw address of a Solana wallet (default: this wallet) */
export async function withdraw(w: Wallet, usd: number, to = w.solana) {
  const ex = client(w);
  const dest = new PublicKey(to);
  if (!PublicKey.isOnCurve(dest.toBytes())) throw new Error('This is not a wallet address. Give the address of a Solana wallet.');
  const addr = await unitAddress('withdraw', dest.toBase58());
  let a = await account(w.perps.address);
  const amount = Math.min(usd, a.withdrawable);
  const ask0 = (await book(USOL.pair)).ask;
  const minUsd = Math.max(MIN_ORDER_USD + 1, Math.ceil(UNIT_MIN_SOL * ask0 * (1 + SLIPPAGE) * 1.01 * 100) / 100);
  if (amount < minUsd) throw new Error(`Withdraw at least $${minUsd.toFixed(2)} (${UNIT_MIN_SOL} SOL, the bridge minimum). Withdrawable now: $${a.withdrawable.toFixed(2)}.`);
  for (const d of DEXES) if (d && (a.freeByDex[d] ?? 0) >= 0.01) await ex.sendAsset({ destination: w.perps.address, sourceDex: d, destinationDex: '', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: (Math.floor(a.freeByDex[d]! * 100) / 100).toFixed(2) });
  await ex.usdClassTransfer({ amount: amount.toFixed(2), toPerp: false });
  a = await account(w.perps.address);
  const before = a.spot.usol;
  const ask = (await book(USOL.pair)).ask;
  const size = (Math.min(a.spot.usdc, amount) * 0.995) / (ask * (1 + SLIPPAGE));
  await ex.order({ orders: [{ a: USOL.asset, b: true, p: formatPrice(ask * (1 + SLIPPAGE), USOL.szDecimals, 'spot'), s: (Math.floor(size * 1000) / 1000).toFixed(3), r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
  a = await account(w.perps.address);
  const bought = Math.floor((a.spot.usol - before) * 1000) / 1000;
  if (!(bought > 0)) throw new Error('Could not buy SOL for the withdrawal. Your USDC is on the spot balance.');
  if (bought < UNIT_MIN_SOL) throw new Error(`Bought ${bought} SOL, below the ${UNIT_MIN_SOL} SOL bridge minimum. Nothing was sent: the SOL is on your spot balance.`);
  await ex.spotSend({ destination: addr as `0x${string}`, token: USOL.token, amount: bought.toFixed(3) });
  return { sol: bought, to: dest.toBase58(), via: addr };
}
