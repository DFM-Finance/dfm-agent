import { createHash } from 'node:crypto';

/**
 * SHA-256 of every DFM wallet whose secret key an agent could load (spec 011 T6,
 * CA-4.12). Digests, not addresses: this package is public and says nothing about
 * what each one does. Add one by hashing its base58 address.
 *
 * On-curve keys only. An off-curve address (a PDA, a program-owned vault) has no
 * secret key, so no keypair can resolve to it: listing one refuses nothing and
 * only publishes a checkable link between that address and DFM.
 * `signing.dfm-held.test.ts` holds every digest to an on-curve preimage.
 */
export const DFM_HELD_WALLET_DIGESTS: readonly string[] = [
  'eccc8acedbf4726457e45712a4491a284b479dfec37f116b84687eef6f3a42df',
];

export function isDfmHeldWallet(pubkeyBase58: string): boolean {
  return DFM_HELD_WALLET_DIGESTS.includes(createHash('sha256').update(pubkeyBase58).digest('hex'));
}
