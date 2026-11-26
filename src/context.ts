/**
 * The per-request context (spec 011 T5, plan decision 3).
 *
 * Everything a tool used to read from module state or `process.env` (the caller's
 * credential, the signing key cache, the write switch, the confirm-phrase env) is
 * carried here and passed down the calls. stdio builds ONE context from the
 * process env, and `envCredentials` reads the same variables, in the same order,
 * at the same moment as before, so a single-caller stdio run is byte-identical.
 * A lane that serves many callers builds one context per request. Nothing here
 * ever writes `process.env`: a credential set there leaks across concurrent
 * requests (qa B4).
 *
 * No runtime imports: reachable from every lane, including the read-only ones.
 */
import type { Keypair } from '@solana/web3.js';
import type { AgentConfig } from './config.js';

/** Where a caller's credential comes from. Read at use time, never cached. */
export interface CredentialSource {
  /** A `dfm_` API key, already trimmed. */
  apiKey(): string | undefined;
  /** An EXPLICITLY chosen keypair file (never the default path that merely exists). */
  keypairPath(): string | undefined;
  /** An inline keypair JSON array. */
  keypairJson(): string | undefined;
}

/** The process env, read per call exactly as the code did before the context existed. */
export const envCredentials: CredentialSource = {
  apiKey: () => process.env.DFM_API_KEY?.trim(),
  keypairPath: () => process.env.DFM_AGENT_KEYPAIR_PATH?.trim(),
  keypairJson: () => process.env.DFM_AGENT_KEYPAIR_JSON,
};

/** Where a loaded signing keypair is remembered. */
export interface KeypairStore {
  get(): Keypair | null;
  set(kp: Keypair): void;
}

export function createKeypairStore(): KeypairStore {
  let kp: Keypair | null = null;
  return { get: () => kp, set: (k) => { kp = k; } };
}

/** stdio: one operator, one key, remembered for the life of the process (today's cache). */
export const processKeypairStore: KeypairStore = createKeypairStore();

/** The two confirm-phrase switches, read per call (a long-lived process may flip them). */
export interface GateEnv {
  nonInteractive(): boolean;
  confirmRequired(): boolean;
}

export const envGates: GateEnv = {
  nonInteractive: () => process.env.DFM_MCP_NONINTERACTIVE_WRITES === '1',
  confirmRequired: () => process.env.DFM_MCP_CONFIRM_REQUIRED === '1',
};

export interface RequestContext {
  credentials: CredentialSource;
  signing: SigningScope;
  gates: GateEnv;
  /** One write switch per lane: stdio reads `DFM_AGENT_WRITE_ENABLED`, Next takes an adapter option. */
  readonly writeEnabled: boolean;
}

/**
 * What signing may use. `host` is a local operator's own key (stdio). `request` is a
 * caller on a shared server: DFM never holds or loads a signing key for a caller,
 * so a request scope signs nothing and `loadTestKeypair` refuses it before reading
 * any path or env (wallets review F2).
 */
export type SigningScope =
  | { readonly kind: 'host'; readonly keypairs: KeypairStore; readonly credentials: CredentialSource }
  | { readonly kind: 'request' };

export const stdioScope: SigningScope = { kind: 'host', keypairs: processKeypairStore, credentials: envCredentials };
export const requestScope: SigningScope = { kind: 'request' };

/** The refusal every request-lane path ends in. */
export const ONLY_DFM_KEY_MSG =
  'this server only accepts a dfm_ key: send it as the X-DFM-Key or Authorization: Bearer header. ' +
  'It holds no sign-in or signing key of its own and never uses one for a caller.';

/**
 * A caller's credential on a shared server: a `dfm_` key and nothing else. Never a
 * keypair path or JSON (F3): DFM never holds a user's key.
 */
export function requestCredentials(apiKey: string | undefined): CredentialSource {
  const key = apiKey?.trim();
  if (!key || !key.startsWith('dfm_')) throw new Error(ONLY_DFM_KEY_MSG);
  return keyOnly({ apiKey: () => key, keypairPath: () => undefined, keypairJson: () => undefined });
}

/** Any source narrowed to its `dfm_` key: whatever else it offers is dropped. */
export function keyOnly(source: CredentialSource): CredentialSource {
  return {
    apiKey: () => {
      const k = source.apiKey();
      return k && k.startsWith('dfm_') ? k : undefined;
    },
    keypairPath: () => undefined,
    keypairJson: () => undefined,
  };
}

let sharedLane = false;

/**
 * Called once by a server that answers many callers (the Next adapter). From then
 * on every host default (env credentials, the host keypair, the stdio context)
 * throws, so a call site that forgot to pass the request context fails loudly
 * instead of falling back to the host's identity (F4). One-way on purpose.
 */
export function enterSharedLane(): void {
  sharedLane = true;
}
export function resetSharedLaneForTests(): void {
  sharedLane = false;
}
export function assertHostDefaults(what: string): void {
  if (sharedLane) {
    throw new Error(`shared lane: ${what} is a host default and is not available while serving callers. Pass the request context.`);
  }
}

/** The stdio context: env credentials, process-lifetime key cache, the config's write switch. */
export function stdioContext(config: AgentConfig): RequestContext {
  assertHostDefaults('the stdio context');
  return {
    credentials: envCredentials,
    signing: stdioScope,
    gates: envGates,
    get writeEnabled() {
      return config.writeEnabled;
    },
  };
}
