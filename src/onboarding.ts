/**
 * HEADLESS-AGENT ONBOARDING over MCP (Top, #101, 2026-10-19): identity wallet →
 * SIWS login → profile (name + avatar) → app wallet → API key, no browser.
 *
 * Everything that touches the disk follows the owner-key rules
 * (`app-wallet-owner.ts`): no symlinks, no foreign uid, no loose perms, the
 * only directory ever created is `~/.config/dfm`, secrets written once with
 * `wx`/0600. The MODEL never chooses a path: the identity keypair lives at
 * `DFM_AGENT_KEYPAIR_PATH` or the default, the avatar at `DFM_AGENT_AVATAR_PATH`
 * or `~/.config/dfm/avatar.<ext>` — so a prompt cannot make the agent upload or
 * overwrite an arbitrary file.
 */
import { Keypair } from '@solana/web3.js';
import { closeSync, constants as fsc, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { DEFAULT_OWNER_KEY_DIR, assertSafeDir, lstatOrNull, myUid } from './app-wallet-owner.js';
import { DEFAULT_KEYPAIR_PATH, type AgentConfig } from './config.js';
import { defaultAvatarPng } from './default-avatar.js';

export const ONBOARDING_ORDER =
  'create_identity_wallet → SIWS login (automatic) → set_profile {displayName} (avatar: operator image or a generated default) → create_app_wallet → app_wallet_fund {usdc, sol} → create_api_key (optional)';

// ─── Identity wallet ─────────────────────────────────────────────────────────

export interface IdentityResult {
  status: 'reused' | 'created';
  publicKey: string;
  source: 'DFM_AGENT_KEYPAIR_PATH' | 'DFM_AGENT_KEYPAIR_JSON' | 'default-path';
  note: string;
}

/**
 * Reuse the configured identity keypair, or create ONE at the default path.
 * Never creates a second: any explicit env or an existing default file wins.
 * `getPubkey` loads it through the same code SIWS uses (it refuses the
 * protocol wallet). On create, `config.keypairPath` is pointed at the new file
 * so the running MCP signs in with it without a restart.
 */
export function ensureIdentityWallet(
  config: AgentConfig,
  getPubkey: (c: AgentConfig) => string,
  defaultPath: string = DEFAULT_KEYPAIR_PATH,
): IdentityResult {
  const explicit = process.env.DFM_AGENT_KEYPAIR_PATH?.trim();
  if (explicit) {
    return { status: 'reused', publicKey: getPubkey(config), source: 'DFM_AGENT_KEYPAIR_PATH', note: 'Reused the identity keypair at DFM_AGENT_KEYPAIR_PATH; nothing was created.' };
  }
  if (config.keypairJsonEnvPresent && !config.keypairPath && !lstatOrNull(defaultPath)) {
    return { status: 'reused', publicKey: getPubkey(config), source: 'DFM_AGENT_KEYPAIR_JSON', note: 'Reused the identity keypair from DFM_AGENT_KEYPAIR_JSON; nothing was created.' };
  }
  if (lstatOrNull(defaultPath)) {
    assertSafeSecretFile(defaultPath);
    config.keypairPath = defaultPath;
    const both = config.keypairJsonEnvPresent
      ? ' DFM_AGENT_KEYPAIR_JSON is also set: both present; the file wins (same as the signer).'
      : '';
    return { status: 'reused', publicKey: getPubkey(config), source: 'default-path', note: `Reused the identity keypair at ${defaultPath}; nothing was created.${both}` };
  }
  // Keyless mode already has an identity: the API key's owner. A second,
  // unrelated SIWS identity would split the agent in two (review S13).
  if (process.env.DFM_API_KEY?.trim()) {
    throw new Error(
      'this MCP already acts for its owner via DFM_API_KEY; identity creation is for keypair-less agents with no key',
    );
  }
  assertSafeDir(dirname(defaultPath));
  const kp = Keypair.generate();
  try {
    writeFileSync(defaultPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: 'wx' });
  } finally {
    kp.secretKey.fill(0);
  }
  config.keypairPath = defaultPath;
  return {
    status: 'created',
    publicKey: getPubkey(config),
    source: 'default-path',
    note:
      `Created a new identity keypair at ${defaultPath} (0600) — back it up offline; it is how this agent signs in. ` +
      'The running MCP already uses it for SIWS (no restart needed). Fund it with a little SOL only if it will pay ' +
      'to fund its app wallet.',
  };
}

/** A secret file this MCP may READ: regular file, not a symlink, ours, 0600-ish. */
export function assertSafeSecretFile(path: string): void {
  const st = lstatOrNull(path);
  if (!st) throw new Error(`${path} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink — refusing to use it`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  const uid = myUid();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is not owned by the current user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users; run chmod 600 on it first`);
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  '.png': { mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.gif': { mime: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': { mime: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/** Where the operator puts the agent's avatar. Null when none is configured / present. */
export function avatarPath(dir: string = DEFAULT_OWNER_KEY_DIR): string | null {
  const env = process.env.DFM_AGENT_AVATAR_PATH?.trim();
  if (env) return env;
  for (const ext of Object.keys(AVATAR_TYPES)) {
    const p = join(dir, `avatar${ext}`);
    if (lstatOrNull(p)) return p;
  }
  return null;
}

/**
 * Read the avatar ONLY if it is a real image: allowed extension, not a symlink,
 * a regular file ≤ 2 MB whose first bytes match that image type. Nothing else
 * is ever sent (the server re-checks magic bytes too).
 */
export function loadAvatar(path: string): { bytes: Buffer; filename: string; mime: string } {
  const type = AVATAR_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error('avatar must be a .png, .jpg, .jpeg, .webp or .gif file');
  // O_NOFOLLOW + fstat on the OPENED fd: no symlink, and no swap between the
  // check and the read (review S14).
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`avatar file ${path} does not exist`);
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`avatar ${path} must be a regular file (no symlinks)`);
    throw e;
  }
  let bytes: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`avatar ${path} must be a regular file (no symlinks)`);
    if (st.size > MAX_AVATAR_BYTES) throw new Error('avatar is larger than 2 MB');
    bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, bytes, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    bytes = bytes.subarray(0, off);
  } finally {
    closeSync(fd);
  }
  if (!type.magic(bytes)) throw new Error('avatar content is not the image type its extension says');
  return { bytes, filename: `avatar${extname(path).toLowerCase()}`, mime: type.mime };
}

/**
 * The avatar set_profile uploads: the OPERATOR's image when one exists (it always
 * wins), otherwise a deterministic identicon PNG drawn from the identity public
 * key, so a headless agent with no image file can still pass the profile gate.
 */
export function resolveAvatar(
  identityPubkey: string,
  path: string | null = avatarPath(),
): { bytes: Buffer; filename: string; mime: string; isDefault: boolean } {
  if (path) return { ...loadAvatar(path), isDefault: false };
  return { bytes: defaultAvatarPng(identityPubkey), filename: 'avatar.png', mime: 'image/png', isDefault: true };
}

/** The API's gate rule (agent-onboarding.ts), mirrored: a chosen name AND an avatar. */
export function profileGap(
  wallet: string | undefined,
  profile: { displayName?: string; effectiveAvatarUri?: string | null } | null | undefined,
): string[] {
  const missing: string[] = [];
  const name = profile?.displayName?.trim() ?? '';
  const auto = wallet ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : null;
  if (!name || name === auto) missing.push('displayName');
  if (!profile?.effectiveAvatarUri) missing.push('avatar');
  return missing;
}

// ─── API key ────────────────────────────────────────────────────────────────

export interface CreateKeyInput {
  name: string;
  readOnly?: boolean;
  perOpNotionalUsdc?: number;
  dailyNotionalUsdc?: number;
  allowedOps?: string[];
  destinationWhitelist?: string[];
  allowedPrograms?: string[];
  allowArbitraryPrograms?: boolean;
  expiresAt?: string;
}

export const DEFAULT_KEY_TTL_MS = 30 * 24 * 3600 * 1000;
export const MAX_KEY_TTL_MS = 90 * 24 * 3600 * 1000;
const WRITE_FIELDS = ['perOpNotionalUsdc', 'dailyNotionalUsdc', 'allowedOps', 'destinationWhitelist', 'allowedPrograms', 'allowArbitraryPrograms'] as const;

/**
 * The exact `POST /agent/keys` body (CreateKeyDto). Review S12: a model can be
 * prompt-injected, so the MCP mints READ-ONLY keys only; a write key (or any
 * write cap) needs the OPERATOR's `DFM_ALLOW_WRITE_KEY_MINT=1`. Every key
 * expires: default now + 30 days, never more than 90.
 */
export function buildCreateKeyBody(input: CreateKeyInput, now: number = Date.now()): Record<string, unknown> {
  const wantsWrite = input.readOnly === false || WRITE_FIELDS.some((k) => input[k] !== undefined);
  if (wantsWrite && process.env.DFM_ALLOW_WRITE_KEY_MINT?.trim() !== '1') {
    throw new Error('refusing to mint a write key from the MCP: only read-only keys, unless the operator sets DFM_ALLOW_WRITE_KEY_MINT=1');
  }
  const expiresMs = input.expiresAt ? Date.parse(input.expiresAt) : now + DEFAULT_KEY_TTL_MS;
  if (!Number.isFinite(expiresMs) || expiresMs <= now) throw new Error('expiresAt must be a future ISO-8601 date');
  if (expiresMs > now + MAX_KEY_TTL_MS) throw new Error('expiresAt may be at most 90 days ahead');
  const policy: Record<string, unknown> = { readOnly: input.readOnly === false ? false : true };
  for (const k of WRITE_FIELDS) if (input[k] !== undefined) policy[k] = input[k];
  return { label: input.name, policy, expiresAt: new Date(expiresMs).toISOString() };
}

export const DEFAULT_API_KEYS_DIR = join(DEFAULT_OWNER_KEY_DIR, 'api-keys');

/** Directory + name checks, run BEFORE minting (review S18): a key is never minted into nowhere. */
export function prepareKeyStore(name: string, dir: string = DEFAULT_API_KEYS_DIR): { dir: string; safeName: string } {
  if (!lstatOrNull(dir)) {
    assertSafeDir(dirname(dir));
    mkdirSync(dir, { mode: 0o700 });
  }
  assertSafeDir(dir);
  return { dir, safeName: name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'key' };
}

/**
 * Write a freshly minted key to `<dir>/<name>-<prefix>.key` (dir 0700, file
 * 0600, `wx`) and return everything EXCEPT the plaintext: the key never
 * enters the chat, so a prompt cannot make the agent paste it anywhere.
 */
export function storeApiKey(
  name: string,
  issued: Record<string, unknown>,
  dir: string = DEFAULT_API_KEYS_DIR,
): Record<string, unknown> {
  const key = issued.key;
  const prefix = String(issued.keyPrefix ?? '');
  if (typeof key !== 'string' || !key.startsWith('dfm_') || !/^dfm_[A-Za-z0-9_-]{1,16}$/.test(prefix)) {
    throw new Error('the API returned no dfm_ key');
  }
  const { safeName } = prepareKeyStore(name, dir);
  const path = join(dir, `${safeName}-${prefix}.key`);
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
  const { key: _plaintext, ...rest } = issued;
  return {
    ...rest,
    path,
    note: `Stored at ${path} (0600). This key never enters the chat; point the other process at that file (e.g. DFM_API_KEY=$(cat ${path})).`,
  };
}

// ─── Funding ────────────────────────────────────────────────────────────────

/**
 * What the API's launch preflight enforces on the APP wallet, mirrored from
 * api/src/shared/solana/launch-funding.ts + balance-precheck.service.ts (keep in
 * sync): a launch with share-mint metadata needs 0.023 SOL (create + rebalancer)
 * + 0.00511 SOL metadata rent floor + 0.01 SOL Metaplex fee = 0.03811 SOL; each
 * deposit's precheck needs 0.02 SOL more. USDC: the factory seed (0.1 USDC
 * today, read live by the API) plus the deposit itself, at least $1 (the
 * deposit minimum the app and this client enforce; the API sets none).
 */
export const LAUNCH_MIN_LAMPORTS = 38_110_731;
export const DEPOSIT_MIN_LAMPORTS = 20_000_000;
export const LAUNCH_SEED_USDC_MICROS = 100_000;

export interface FundingInput {
  identityPubkey: string | null;
  appWallet: string;
  usdcMicros: number;
  solLamports: number;
  keyless: boolean;
  writeEnabled: boolean;
}

/** Null when the app wallet already covers a launch; otherwise the exact funding step. */
export function fundingNextStep(f: FundingInput): string | null {
  if (f.usdcMicros > LAUNCH_SEED_USDC_MICROS && f.solLamports >= LAUNCH_MIN_LAMPORTS + DEPOSIT_MIN_LAMPORTS) return null;
  const have = `App wallet ${f.appWallet} holds ${f.usdcMicros / 1e6} USDC and ${f.solLamports / 1e9} SOL.`;
  const need =
    'To launch a fund and make its first deposit it needs: USDC = 0.1 (factory seed, read live at launch) + the ' +
    'amount you will deposit (minimum $1, as in the app), and SOL ≥ 0.0381 for the launch (0.023 without ' +
    'share-mint metadata) + 0.02 per deposit — about 0.06 SOL total.';
  if (f.keyless) {
    return `${have} ${need} This MCP runs on an API key (no local keypair), so it cannot sign a top-up: send USDC + SOL to the app wallet address from any wallet (an agent\'s or a person\'s, it does not matter), or fund it at https://app.dfm.finance/account.`;
  }
  const to = f.identityPubkey ? `the identity wallet ${f.identityPubkey}` : 'the identity wallet (create_identity_wallet prints it)';
  const gate = f.writeEnabled
    ? 'Writes are enabled.'
    : 'Writes are OFF: the operator sets DFM_AGENT_WRITE_ENABLED=true and restarts the MCP (no API key is needed — the identity keypair signs in with SIWS).';
  return (
    `${have} ${need} Step 1: send that USDC plus that SOL and ~0.01 SOL extra for fees to ${to} (Solana mainnet). ` +
    `Step 2: call app_wallet_fund {usdc, sol} — it moves them from the identity wallet into the app wallet. ${gate}`
  );
}

// ─── onboard ────────────────────────────────────────────────────────────────

/**
 * The whole create_api_key: check the store, mint, store; if storing fails
 * after the mint, REVOKE the key so no live credential is left unrecorded.
 */
export async function mintAndStoreKey(
  input: CreateKeyInput,
  api: { createApiKey(b: Record<string, unknown>): Promise<Record<string, unknown>>; revokeApiKey(id: string): Promise<unknown> },
  dir: string = DEFAULT_API_KEYS_DIR,
): Promise<Record<string, unknown>> {
  const body = buildCreateKeyBody(input);
  prepareKeyStore(input.name, dir);
  const issued = await api.createApiKey(body);
  try {
    return storeApiKey(input.name, issued, dir);
  } catch (e) {
    const id = typeof issued.id === 'string' ? issued.id : null;
    const revoked = id ? await api.revokeApiKey(id).then(() => true, () => false) : false;
    throw new Error(
      `the key was minted but could not be stored (${(e as Error).message}); ` +
        (revoked ? 'it was revoked, nothing is left live' : `REVOKE IT NOW (id ${id ?? 'unknown'}, prefix ${String(issued.keyPrefix ?? '?')})`),
    );
  }
}

export interface OnboardDeps {
  identity(): IdentityResult;
  /** Only when DFM_API_KEY is set: throws unless the key's owner IS the SIWS wallet (fail closed). */
  assertSameIdentity?(): Promise<void>;
  getProfile(): Promise<{ wallet?: string; displayName?: string; effectiveAvatarUri?: string | null } | null>;
  createAppWallet(): Promise<Record<string, unknown>>;
  /** Optional: the app wallet's live float, to print the funding step. */
  getBalance?(): Promise<{ address?: string | null; usdcMicros?: number; solLamports?: number } | null>;
  keyless?: boolean;
  writeEnabled?: boolean;
}

/**
 * Run the steps in order and stop at the first one that needs the operator.
 * Never mints an API key (that grants authority — the agent asks for it explicitly).
 */
export async function runOnboard(deps: OnboardDeps): Promise<Record<string, unknown>> {
  const identity = deps.identity();
  if (deps.assertSameIdentity) {
    try {
      await deps.assertSameIdentity();
    } catch (e) {
      return { done: false, missingStep: 'identity_mismatch', identity, error: (e as Error).message, order: ONBOARDING_ORDER };
    }
  }
  let profile;
  try {
    profile = await deps.getProfile();
  } catch (e) {
    return { done: false, missingStep: 'login', identity, error: (e as Error).message, order: ONBOARDING_ORDER };
  }
  const missing = profileGap(profile?.wallet ?? identity.publicKey, profile);
  if (missing.length > 0) {
    return {
      done: false,
      missingStep: 'set_profile',
      missing,
      identity,
      next:
        'Run set_profile {displayName}. With no image at DFM_AGENT_AVATAR_PATH or ~/.config/dfm/avatar.png it ' +
        'uploads a generated default avatar (an identicon of the identity public key), so no file is required.',
      order: ONBOARDING_ORDER,
    };
  }
  const appWallet = await deps.createAppWallet();
  let funding: string | null = null;
  if (deps.getBalance) {
    const bal = await deps.getBalance().catch(() => null);
    if (bal?.address) {
      funding = fundingNextStep({
        identityPubkey: identity.publicKey,
        appWallet: bal.address,
        usdcMicros: bal.usdcMicros ?? 0,
        solLamports: bal.solLamports ?? 0,
        keyless: deps.keyless === true,
        writeEnabled: deps.writeEnabled === true,
      });
    }
  }
  return {
    done: true,
    identity,
    appWallet,
    ...(funding ? { missingStep: 'fund_app_wallet' } : {}),
    next: funding
      ? `${funding} Optional afterwards: create_api_key {name} for other processes.`
      : 'Funded. Optional: create_api_key {name} for other processes. Next: launch_vault.',
    order: ONBOARDING_ORDER,
  };
}
