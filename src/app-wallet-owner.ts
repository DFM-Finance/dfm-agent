/**
 * The OWNER KEY of a headless agent's app wallet (2026-10-19).
 *
 * An agent with no browser cannot be a Privy user, so its app wallet is owned
 * by a P-256 key generated HERE, on the agent's machine. DFM only ever sees the
 * public half; the private key signs exactly one kind of request: the Privy
 * PATCH that sets DFM's policy-bound signer on the wallet.
 *
 * Rules this file enforces (it does NOT trust the DFM server):
 *   • the PEM is written once, mode 0600, with `wx` (never overwrites); an
 *     existing file is reused — rotating it would orphan the wallet. Symlinks
 *     (file or parent dir), a file owned by another uid, or one readable by
 *     group/others are refused, not "fixed". Only `~/.config/dfm` itself is
 *     ever created (0700); any other missing directory is refused;
 *   • the request is checked against values PINNED HERE, not against the
 *     server's own answer: `signer_id` must be DFM's signer quorum and
 *     `privy-app-id` DFM's Privy app (both overridable only by local env), the
 *     body exactly one signer with exactly one policy, the headers exactly
 *     {privy-app-id, privy-request-expiry} with an expiry in the next 10 min;
 *   • the payload is rebuilt locally and must equal the server's.
 * RESIDUAL: the policy id is trusted to DFM's server. Reading a policy's
 * content needs Privy's app secret, which only the server has — the server
 * re-reads it from Privy before handing the request out, the agent cannot.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_OWNER_KEY_DIR = join(homedir(), '.config', 'dfm');
export const DEFAULT_OWNER_KEY_PATH = join(DEFAULT_OWNER_KEY_DIR, 'app-wallet-owner.pem');
/** DFM's Privy signer key quorum (the production `PRIVY_EMBEDDED_SIGNER_QUORUM_ID`). */
export const DFM_PRIVY_SIGNER_QUORUM_ID = 'elhpm1tlfxhqimb397m9opg8';
/** DFM's Privy app id — public: it ships in the web bundle (`VITE_PRIVY_APP_ID`, web/src/lib/dev-proxy.ts). */
export const DFM_PRIVY_APP_ID = 'cmrgqda8l00yo0cl9j49ye64k';
/** The furthest ahead a `privy-request-expiry` may be before the agent refuses to sign it. */
export const MAX_REQUEST_EXPIRY_AHEAD_MS = 10 * 60 * 1000;

/** The pins, overridable ONLY by the agent operator's local env (never by the server). */
export function signerPins(): { signerId: string; appId: string } {
  return {
    signerId: process.env.DFM_PRIVY_SIGNER_QUORUM_ID?.trim() || DFM_PRIVY_SIGNER_QUORUM_ID,
    appId: process.env.DFM_PRIVY_APP_ID?.trim() || DFM_PRIVY_APP_ID,
  };
}

/** Owner key path: `DFM_APP_WALLET_OWNER_KEY_PATH` or the default. Never a tool argument. */
export function ownerKeyPath(): string {
  return process.env.DFM_APP_WALLET_OWNER_KEY_PATH?.trim() || DEFAULT_OWNER_KEY_PATH;
}

export interface OwnerKey {
  path: string;
  /** base64 DER SPKI — the format Privy's `owner.public_key` and key quorums use. */
  publicKey: string;
  created: boolean;
  sign(payload: string): string;
}

export const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
export const myUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/** The owner-key directory rules, shared by every secret this MCP writes (identity keypair too). */
export function assertSafeDir(dir: string): void {
  let st = lstatOrNull(dir);
  if (!st) {
    if (resolve(dir) !== resolve(DEFAULT_OWNER_KEY_DIR)) throw new Error(`${dir} does not exist — create it yourself (0700) first`);
    mkdirSync(dir, { mode: 0o700 }); // ~/.config/dfm only, not recursive
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink — refusing to keep an owner key behind it`);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = myUid();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is not owned by the current user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${dir} is writable by other users`);
}

/** Load the owner key at `path`, or create it (0600) when absent. */
export function loadOrCreateOwnerKey(path: string = ownerKeyPath()): OwnerKey {
  assertSafeDir(dirname(path));
  let pem: string;
  let created = false;
  const st = lstatOrNull(path);
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${path} is a symlink — refusing to use it as the owner key`);
    if (!st.isFile()) throw new Error(`${path} exists and is not a regular file`);
    const uid = myUid();
    if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is not owned by the current user`);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it first`);
    }
    pem = readFileSync(path, 'utf8');
  } else {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    // `wx`: fail if anything (file or symlink) appeared in between — never overwrite an owner key.
    writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
    created = true;
  }
  const priv = createPrivateKey({ key: pem, format: 'pem' });
  if (priv.asymmetricKeyType !== 'ec' || priv.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${path} is not a P-256 (prime256v1) private key`);
  }
  const publicKey = Buffer.from(createPublicKey(priv).export({ type: 'spki', format: 'der' })).toString('base64');
  return {
    path,
    publicKey,
    created,
    sign: (payload: string) => sign('sha256', Buffer.from(payload, 'utf8'), priv).toString('base64'),
  };
}

/** RFC 8785 (JCS) for the JSON shapes Privy signs: sorted keys, ES string/number serialization. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export interface SignerRequest {
  method: string;
  url: string;
  body: { additional_signers: Array<{ signer_id: string; override_policy_ids: string[] }> };
  headers: Record<string, string>;
  payload: string;
}

const keysAre = (o: unknown, keys: string[]): boolean =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();

/**
 * Refuse anything that is not "set THIS wallet's signers to exactly [DFM's
 * pinned quorum with exactly [policyId]]", for DFM's pinned app, expiring
 * within 10 minutes. Returns the locally rebuilt payload to sign.
 */
export function checkSignerRequest(
  req: SignerRequest,
  expect: { walletId: string; policyId: string },
  now: number = Date.now(),
): string {
  const pins = signerPins();
  const url = `https://api.privy.io/v1/wallets/${encodeURIComponent(expect.walletId)}`;
  const s = req?.body?.additional_signers;
  const entry = Array.isArray(s) && s.length === 1 ? s[0] : undefined;
  const ids = entry?.override_policy_ids;
  const expiry = req?.headers?.['privy-request-expiry'];
  const shapeOk =
    keysAre(req, ['method', 'url', 'body', 'headers', 'payload']) &&
    req.method === 'PATCH' &&
    req.url === url &&
    keysAre(req.body, ['additional_signers']) &&
    keysAre(entry, ['signer_id', 'override_policy_ids']) &&
    entry?.signer_id === pins.signerId &&
    Array.isArray(ids) && ids.length === 1 &&
    typeof expect.policyId === 'string' && expect.policyId.length > 0 &&
    ids[0] === expect.policyId &&
    keysAre(req.headers, ['privy-app-id', 'privy-request-expiry']) &&
    req.headers['privy-app-id'] === pins.appId &&
    typeof expiry === 'string' && /^\d{13}$/.test(expiry) &&
    Number(expiry) > now && Number(expiry) <= now + MAX_REQUEST_EXPIRY_AHEAD_MS;
  if (!shapeOk) {
    throw new Error('refusing to sign: the request is not exactly "set DFM’s pinned signer with one per-wallet policy, expiring within 10 min"');
  }
  const payload = canonicalJson({ version: 1, method: 'PATCH', url, body: req.body, headers: req.headers });
  if (payload !== req.payload) throw new Error('refusing to sign: the server payload differs from the request it describes');
  return payload;
}

type Step =
  | { status: 'active'; created: boolean; appWallet: Record<string, unknown> }
  | {
      status: 'awaiting_owner_signature';
      reason?: 'create' | 'policy_update';
      walletId: string;
      address: string;
      signerId: string;
      policyId: string;
      request: SignerRequest;
    };

/**
 * The whole `create_app_wallet` flow: load/create the owner key, send its
 * PUBLIC half, check + sign the one signer request (a creation or a policy
 * reissue), confirm. Idempotent end to end — re-running resumes the same
 * wallet with the same key.
 */
export async function runCreateAppWallet(
  api: {
    beginAgentAppWallet(ownerPublicKey: string): Promise<Step>;
    confirmAgentAppWallet(ownerPublicKey: string, signature: string): Promise<Step>;
  },
  keyPath: string = ownerKeyPath(),
): Promise<Record<string, unknown>> {
  const key = loadOrCreateOwnerKey(keyPath);
  const ownerKey = { path: key.path, publicKey: key.publicKey, createdNow: key.created };
  let step = await api.beginAgentAppWallet(key.publicKey);
  const signed = step.status === 'awaiting_owner_signature' ? (step.reason ?? 'create') : null;
  if (step.status === 'awaiting_owner_signature') {
    const payload = checkSignerRequest(step.request, step);
    step = await api.confirmAgentAppWallet(key.publicKey, key.sign(payload));
  }
  if (step.status !== 'active') throw new Error(`unexpected app wallet status: ${(step as { status?: string }).status}`);
  return {
    status: 'active',
    created: step.created,
    ...(signed === 'policy_update' ? { policyUpdated: true } : {}),
    appWallet: step.appWallet,
    ownerKey,
    note:
      `The owner key at ${key.path} is the ONLY key that owns this app wallet — back it up offline. ` +
      'DFM cannot recover it. Fund it by sending USDC + a little SOL to the app wallet address from ANY wallet ' +
      '(this agent\'s identity wallet, another wallet it controls, or a person\'s — who sends does not matter), ' +
      'then deposit/launch as usual.',
  };
}

export const POLICY_UPDATE_NOTICE = "DFM's signing rules changed — run create_app_wallet to approve them";

/**
 * The line `app_wallet` / `whoami` add when the API flags a pending policy
 * reissue for this agent-key wallet. Signing keeps working on the old policy
 * meanwhile (web parity), so this informs; it never blocks.
 */
export function policyUpdateNotice(op: { policyUpdateRequired?: unknown } | null | undefined): { policyUpdate?: string } {
  return op?.policyUpdateRequired === true ? { policyUpdate: POLICY_UPDATE_NOTICE } : {};
}
