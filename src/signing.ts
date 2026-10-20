/**
 * LOCAL signing — the security boundary of the agent.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  SECURITY INVARIANTS (do not weaken):
 *   1. The test-wallet secret key is loaded ONLY here, ONLY from a local source
 *      the operator controls: a file path (`DFM_AGENT_KEYPAIR_PATH`) or an
 *      env-injected JSON array (`DFM_AGENT_KEYPAIR_JSON`).
 *   2. The secret key NEVER crosses the MCP boundary: it is never a tool
 *      argument, never part of a tool result, and never logged. Only the PUBLIC
 *      key (base58) is ever surfaced.
 *   3. Any error thrown from here is scrubbed of key material (we only ever
 *      include the public key or a generic reason).
 *   4. The operator MUST use a dedicated throwaway test wallet — we cannot tell
 *      "this is the wrong wallet" from a pubkey alone. As defense-in-depth we DO
 *      hard-block the one well-known protocol pubkey (see PROTOCOL_WALLET): a
 *      loaded keypair that resolves to it is zeroed and refused.
 *  ──────────────────────────────────────────────────────────────────────────
 *
 * The keypair is loaded lazily (first WRITE call), so the read-only tools and
 * `npx tsx` smoke runs never touch key material.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { AgentConfig } from './config.js';

/**
 * The single hot Protocol Wallet (DIEGO_2) — `factory.admin` + fee recipient +
 * upgrade authority + backend signer. The agent must NEVER sign with this. If a
 * loaded keypair resolves to this pubkey we refuse immediately: a test agent
 * holding the protocol key is a critical misconfiguration.
 */
const PROTOCOL_WALLET = '9GjEBsZ1Cos2J6inmgwhBKv9pXGNtLSJ7xQ9xZb29bET';

let cachedKeypair: Keypair | null = null;

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
const myUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/**
 * Harden the on-disk keypair path before reading it.
 *
 * Mirrors the owner-key checks in `app-wallet-owner.ts`: symlinks (file or
 * directory), files owned by another uid, and any group/other access are
 * refused outright. The env-JSON escape hatch bypasses the filesystem entirely.
 */
function assertSafeKeypairPath(filePath: string): void {
  const path = resolve(filePath);
  const dir = dirname(path);

  const dirSt = lstatOrNull(dir);
  if (!dirSt) throw new Error(`Keypair directory ${dir} does not exist.`);
  if (dirSt.isSymbolicLink()) throw new Error(`${dir} is a symlink — refusing to keep a keypair behind it`);
  if (!dirSt.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = myUid();
  if (uid !== undefined && dirSt.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
  if ((dirSt.mode & 0o022) !== 0) throw new Error(`${dir} is writable by other users`);

  const st = lstatOrNull(path);
  if (!st) {
    throw new Error(
      `Could not read test keypair file at DFM_AGENT_KEYPAIR_PATH (ENOENT). ` +
        `Set it to a Solana secret-key JSON file the operator controls locally.`,
    );
  }
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink — refusing to use it as a keypair file`);
  if (!st.isFile()) throw new Error(`${path} exists and is not a regular file`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is not owned by the current user`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it first`,
    );
  }
}

/** Parse a Solana 64-byte secret-key JSON array into a Keypair. */
function keypairFromJsonArray(json: string, source: string): Keypair {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    // Do NOT echo the content — it may BE the secret.
    throw new Error(`Test keypair from ${source} is not valid JSON (expected a 64-number array).`);
  }
  if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
    throw new Error(
      `Test keypair from ${source} must be a JSON array of 64 (full secret) or 32 (seed) bytes; got length ${
        Array.isArray(arr) ? arr.length : 'non-array'
      }.`,
    );
  }
  const bytes = Uint8Array.from(arr as number[]);
  try {
    // ⚠️ Do NOT zero `bytes` after derivation. `Keypair.fromSecretKey` does NOT
    // copy its input — the returned keypair's secretKey is BACKED BY this very
    // buffer — so wiping it corrupts the live key → every signature fails with
    // SIWS "Invalid signature" (#19: the v.490 regression). The buffer is GC'd
    // normally; an in-memory-wipe is not worth bricking the key.
    return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`Test keypair from ${source} is not a valid Ed25519 secret key.`);
  }
}

/**
 * Load (and cache) the operator's local test keypair. Throws a clear,
 * key-material-free error if no source is configured or the material is invalid.
 * Caller MUST have already verified `config.writeEnabled` — this function does
 * not gate on the write flag (separation of concerns), but it is only reachable
 * from the write path.
 */
export function loadTestKeypair(config: AgentConfig): Keypair {
  if (cachedKeypair) return cachedKeypair;

  let kp: Keypair;
  if (config.keypairPath) {
    assertSafeKeypairPath(config.keypairPath);
    let raw: string;
    try {
      raw = readFileSync(config.keypairPath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'read error';
      throw new Error(
        `Could not read test keypair file at DFM_AGENT_KEYPAIR_PATH (${code}). ` +
          `Set it to a Solana secret-key JSON file the operator controls locally.`,
      );
    }
    kp = keypairFromJsonArray(raw, 'DFM_AGENT_KEYPAIR_PATH');
  } else if (config.keypairJsonEnvPresent) {
    // Read straight from the env at use-time (not cached as a string anywhere).
    kp = keypairFromJsonArray(process.env.DFM_AGENT_KEYPAIR_JSON as string, 'DFM_AGENT_KEYPAIR_JSON');
  } else {
    throw new Error(
      'No test keypair configured. Set DFM_AGENT_KEYPAIR_PATH (path to a Solana ' +
        'secret-key JSON file) or DFM_AGENT_KEYPAIR_JSON (the JSON array inline). ' +
        'Use a DEDICATED throwaway test wallet — never the protocol wallet.',
    );
  }

  const pubkey = kp.publicKey.toBase58();
  if (pubkey === PROTOCOL_WALLET) {
    // Wipe and refuse.
    kp.secretKey.fill(0);
    throw new Error(
      'REFUSING to load the protocol wallet as the agent test keypair. The agent ' +
        'must sign with a dedicated throwaway test wallet, never the protocol hot wallet.',
    );
  }

  cachedKeypair = kp;
  return kp;
}

/** The agent's test-wallet PUBLIC key (base58). Safe to surface + log. */
export function getTestWalletPubkey(config: AgentConfig): string {
  return loadTestKeypair(config).publicKey.toBase58();
}

/**
 * Sign a UTF-8 SIWS message with the test keypair, returning a base58-encoded
 * Ed25519 signature — exactly what `POST /auth/siws` expects in `signature`.
 * The message MUST be the verbatim string the API returned from `POST
 * /auth/nonce` (the server re-derives the domain + nonce and verifies the
 * signature over that exact text).
 */
export function signSiwsMessage(config: AgentConfig, message: string): string {
  const kp = loadTestKeypair(config);
  const messageBytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(messageBytes, kp.secretKey);
  return bs58.encode(sig);
}

/**
 * Sign one base64-encoded transaction with the test keypair and return it
 * re-serialized to base64, ready to submit. The tx already carries the API's
 * recent blockhash + fee-payer (the test wallet); we only attach its signature.
 *
 * Handles BOTH wire formats: the zap-v2 / create `/prepare` endpoints return v0
 * `VersionedTransaction`s, but the MANAGER endpoints (`assets/prepare`,
 * `transfer-admin`) return LEGACY `Transaction`s. Deserializing a legacy tx as
 * versioned mis-parses it → "Transaction did not pass signature verification",
 * which broke the manager tools. We route by the wire version byte.
 */
export function signBase64Transaction(config: AgentConfig, base64Tx: string): string {
  const kp = loadTestKeypair(config);
  const raw = Buffer.from(base64Tx, 'base64');
  if (isVersionedTxBytes(raw)) {
    const tx = VersionedTransaction.deserialize(raw);
    if (tx.version === 1) return signV1Wire(raw, tx, kp);
    tx.sign([kp]);
    return Buffer.from(tx.serialize()).toString('base64');
  }
  const tx = Transaction.from(raw);
  tx.partialSign(kp); // keep any signature the API already attached
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

/**
 * A v1 wire (the API's `ZAP_TX_V1_*` paths). web3.js 1.99 PARSES v1 but cannot
 * write it back — `tx.sign()` and `tx.serialize()` both throw — so the wire the
 * API handed us is signed IN PLACE: `wire = compact-u16 signature count · 64-byte
 * signatures · message`. The message bytes are what a signer signs, the keypair's
 * slot is its index among the required signers, and everything else is returned
 * byte-for-byte (the API verifies the message it prepared against the one it
 * gets back, so nothing may be re-encoded). Pure ed25519 via tweetnacl.
 */
function signV1Wire(raw: Buffer, tx: VersionedTransaction, kp: Keypair): string {
  const count = tx.signatures.length;
  if (count === 0 || count >= 0x80) {
    throw new Error(`v1 wire: unsupported signature count ${count}`);
  }
  const message = raw.subarray(1 + 64 * count);
  const slot = tx.message.staticAccountKeys.findIndex((k) => k.equals(kp.publicKey));
  if (slot < 0 || slot >= count) {
    throw new Error('v1 wire: this keypair is not one of the required signers');
  }
  const out = Buffer.from(raw);
  out.set(nacl.sign.detached(message, kp.secretKey), 1 + 64 * slot);
  return out.toString('base64');
}

/**
 * True if `raw` is a v0 VersionedTransaction (vs a legacy Transaction). After the
 * compact-u16 signature array, a versioned message's first byte has the high bit
 * (0x80) set to encode the version; a legacy message's first byte is
 * `numRequiredSignatures` (high bit clear).
 *
 * Exported for `signing.money-path.test.ts` — this hand-rolled parser is what
 * decides `sign()` vs `partialSign()` on every real-money write, and getting it
 * wrong produces "Transaction did not pass signature verification" at broadcast
 * time, not at build time.
 */
export function isVersionedTxBytes(raw: Buffer): boolean {
  let offset = 0;
  let sigCount = 0;
  let shift = 0;
  for (;;) {
    if (offset >= raw.length) {
      throw new Error('Malformed transaction bytes: truncated signature-count prefix.');
    }
    const b = raw[offset++]!;
    sigCount |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  offset += sigCount * 64; // each signature is 64 bytes
  if (offset >= raw.length) {
    throw new Error('Malformed transaction bytes: truncated message header after signatures.');
  }
  return (raw[offset]! & 0x80) !== 0;
}
