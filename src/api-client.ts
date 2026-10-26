/**
 * DFM v2 API client.
 *
 * Two request surfaces:
 *   - `publicRequest` — no auth (for `GET /vaults`, `/vaults/:address`).
 *     These are `@Public()` on the API.
 *   - `authRequest`   — attaches `Authorization: Bearer <token>` from the SIWS
 *     session; on a 401 it re-authenticates once and retries. Used for
 *     `/portfolio`, `/vaults/:address/zap-v2/status/:user`, and every
 *     `/prepare` endpoint.
 *
 * All addresses are validated as base58 before hitting the network. The client
 * NEVER sees the secret key — signing is delegated to `signing.ts` via the
 * write methods, and auth is delegated to `SiwsSession`.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AgentConfig } from './config.js';
import { SiwsSession } from './session.js';
import { dfmClientHeaders } from './client-header.js';
import type { SignerRequest } from './app-wallet-owner.js';

/** Response of the headless app-wallet routes (see api agent-app-wallet.controller.ts). */
export type AgentAppWalletStep =
  | { status: 'active'; created: boolean; appWallet: { operatingWalletAddress?: string; status?: string } & Record<string, unknown> }
  | { status: 'awaiting_owner_signature'; reason?: 'create' | 'policy_update'; walletId: string; address: string; signerId: string; policyId: string; request: SignerRequest };
import type {
  VaultListResponse,
  VaultDetailResponse,
  ZapV2Status,
  ZapV2PrepareResponse,
  ZapV2SingleTxResponse,
  CreateAssetInput,
  CreatePrepareResponse,
  CreateConfirmResponse,
  RebalanceToTargetsResponse,
  ReconfigureResponse,
  ReconfigureTargetInput,
} from './types.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function requireBase58(addr: string, label: string): void {
  if (!BASE58_RE.test(addr)) {
    throw new Error(`Invalid base58 ${label}: ${addr}`);
  }
}

/**
 * Canonical JSON for an operation id: object keys sorted recursively, so two
 * calls that MEAN the same write hash identically regardless of key order.
 * Money fields travel as strings server-side, so no number-precision games.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * The operation's identity for ONE keyless write (A7): same tool + same args.
 * It is only the BASE of the idempotency key — `executeViaOperatingWallet`
 * adds a per-operation nonce, reused only while the previous identical call
 * has not returned a result (a lost response, a timeout, an error): that is a
 * retry, and the server collapses it. Once a call returns, the next identical
 * call is a NEW operation — pinning the key to the args alone made the server
 * replay a 24 h-old result to state-dependent tools (`rebalance_to_targets`
 * said "already converged" on a fund 10 % off target; a second identical
 * deposit would have returned the first one's signature) — #109.
 */
function operatingOperationKey(tool: string, args: Record<string, unknown>): string {
  const digest = createHash('sha256').update(`${tool}\n${stableStringify(args)}`).digest('hex');
  return `opexec-${digest}`;
}

/** Launch-surface label (`launchedVia: 'mcp'` on the API side) — never a credential. */
const CLIENT_HEADERS = dfmClientHeaders();

/** How long an unanswered keyless write keeps its key for a retry. */
const OPERATION_RETRY_WINDOW_MS = 30 * 60_000;

export class DfmApiClient {
  private readonly baseUrl: string;
  /** Keyless writes that have not returned a result yet: base → the key their retry must reuse. */
  private readonly unansweredOps = new Map<string, { key: string; at: number }>();

  constructor(
    config: AgentConfig,
    private readonly session: SiwsSession,
  ) {
    this.baseUrl = config.apiUrl;
  }

  // ─── low-level request helpers ─────────────────────────────────────────

  private async publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DFM API ${res.status} on ${path}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  private async authRequest<T>(
    path: string,
    init?: RequestInit & {
      /**
       * Pin the `X-Idempotency-Key` to the operation's OWN identity instead of a
       * fresh UUID. Pass this for any TERMINAL write (one that broadcasts or
       * records something), so a caller-level retry of the same logical
       * operation collapses onto the server's cached response instead of
       * executing twice. Do NOT pass it for a `/prepare` call: a re-prepare is
       * genuinely asking for a NEW transaction (fresh blockhash), and a pinned
       * key would replay the stale, already-expired one.
       *
       * The server's Redis key is `idempotency:<caller>:<key>` — the path is NOT
       * part of it — so every pinned key must carry its own endpoint prefix or
       * two different routes sharing an identity (e.g. a signature) collide.
       */
      idempotencyKey?: string;
      /** Force the SIWS lane even when DFM_API_KEY is set (routes the API marks @SessionOnly). */
      sessionOnly?: boolean;
    },
  ): Promise<T> {
    // The API requires an X-Idempotency-Key on every mutating request. Generate
    // ONE key per logical call and reuse it across the transparent 401 re-auth
    // retry below, so a retry is treated as the same operation (never doubled).
    const { idempotencyKey: pinnedKey, sessionOnly, ...reqInit } = init ?? {};
    const method = (reqInit.method ?? 'GET').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    const idempotencyKey = mutating ? (pinnedKey ?? randomUUID()) : undefined;
    const common = (extra: Record<string, string>) => ({
      'Content-Type': 'application/json',
      ...CLIENT_HEADERS,
      ...extra,
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      ...((reqInit.headers as Record<string, string>) ?? {}),
    });

    // ── PATH A — `dfm_` API KEY (preferred) ─────────────────────────────
    // When DFM_API_KEY is set the MCP needs NO Solana keypair at all: the key
    // resolves server-side to its owner wallet plus the credential's caps.
    // That matters because a leaked keypair IS the wallet, whereas a leaked API
    // key is revocable and capped (read-only unless explicitly widened).
    // There is no re-auth loop here — a key cannot be refreshed from the MCP
    // side. A 401 means the key was revoked OR expired (the server enforces
    // `expiresAt`); silently retrying a dead credential would be wrong either
    // way, so the caller is told to mint a new one.
    const apiKey = sessionOnly ? undefined : process.env.DFM_API_KEY?.trim();
    if (apiKey) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...reqInit,
        headers: common({ 'X-DFM-Key': apiKey }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) {
          throw new Error(
            `DFM API 401 on ${path}: the DFM_API_KEY is invalid or was revoked. ` +
              `Mint a new one with POST /agent/keys.`,
          );
        }
        throw new Error(`DFM API ${res.status} on ${path}: ${body.slice(0, 400)}`);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    // ── PATH B — SIWS with a local keypair (legacy; unchanged) ───────────────
    const send = async (token: string): Promise<Response> =>
      fetch(`${this.baseUrl}${path}`, {
        ...reqInit,
        headers: common({ Authorization: `Bearer ${token}` }),
      });

    let token = await this.session.getAccessToken();
    let res = await send(token);
    // One transparent re-auth on token expiry/rotation.
    if (res.status === 401) {
      token = await this.session.getAccessToken(true);
      res = await send(token);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DFM API ${res.status} on ${path}: ${body.slice(0, 400)}`);
    }
    // 204 No Content — or any empty 2xx body — → undefined. The zap-v2 status
    // endpoint returns an empty body when the user has no open escrow; calling
    // res.json() on it throws "Unexpected end of JSON input", which previously
    // killed the deposit/redeem flow on its very first (existing-escrow) check.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ─── READ (safe) ───────────────────────────────────────────────────────

  /**
   * `GET /vaults` (public) — the SAME query surface the marketplace UI uses
   * (`web/src/services/api.ts` → `vaultsService.list`).
   *
   * ⚠️ The names here are load-bearing. The API validates this query with
   * `VaultListQueryDto` under a global `forbidNonWhitelisted` pipe, so an
   * unknown param is a hard 400, not an ignored hint. `category` is coerced to a
   * number and rejects NaN; `sortBy` is an enum
   * and `limit` is capped at 50 server-side; both are mirrored in the tool
   * schema so a bad value fails locally with a readable message.
   */
  async listVaults(params?: {
    category?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    page?: number;
    limit?: number;
    search?: string;
    creator?: string;
  }): Promise<VaultListResponse> {
    const q = new URLSearchParams();
    if (params?.category !== undefined) q.set('category', String(params.category));
    if (params?.sortBy) q.set('sortBy', params.sortBy);
    if (params?.sortDir) q.set('sortDir', params.sortDir);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.search) q.set('search', params.search);
    if (params?.creator) q.set('creator', params.creator);
    const qs = q.toString();
    return this.publicRequest<VaultListResponse>(`/vaults${qs ? `?${qs}` : ''}`);
  }

  /**
   * `GET /assets/search?q=&class=` (public) — resolve WORDS into MINTS via
   * Jupiter.
   *
   * WHY THE NPX NEEDS THIS AT ALL: without it an external agent has no way to
   * turn "AI tokens" or "BONK" into an address, so its only options are to ask
   * the human for a mint or to state one from memory — and stating a mint from
   * memory is the single failure mode with total-loss consequences (tickers
   * collide, impersonation is routine). The in-app agent has had this tool
   * since v.838; the npx did not, which made the two lanes unequal in the one
   * place it mattered most.
   */
  async searchTokens(
    query: string,
    assetClass?: string,
  ): Promise<unknown> {
    const q = new URLSearchParams({ q: query });
    if (assetClass) q.set('class', assetClass);
    return this.publicRequest<unknown>(`/assets/search?${q.toString()}`);
  }

  /**
   * `GET /prices/:mint` (public) — live USD for ONE mint.
   *
   * A MISSING PRICE IS DATA, not an error: it means no usable route or
   * liquidity, which is itself the answer to "can this be a basket leg". The
   * caller resolves per mint and reports the omission rather than substituting
   * a zero.
   */
  /** `GET /protocol/facts` — live factory numbers (K1); no auth. */
  async getProtocolFacts(): Promise<unknown> {
    return this.publicRequest<unknown>('/protocol/facts');
  }

  async getTokenPrice(mint: string): Promise<unknown> {
    requireBase58(mint, 'mint');
    return this.publicRequest<unknown>(`/prices/${mint}`);
  }

  /** `GET /vaults/:address` (public) — wraps the doc under `{ vault, ... }`. */
  async getVault(address: string): Promise<VaultDetailResponse> {
    requireBase58(address, 'vault address');
    return this.publicRequest<VaultDetailResponse>(`/vaults/${address}`);
  }

  /**
   * `GET /vaults/:address/zap-v2/status/:user` (auth) — decoded ZapEscrowV2 or
   * null. The session wallet must equal `user` (or be the vault admin), else 403.
   * Returns `null` when the user has no open escrow.
   */
  async getZapV2Status(vaultAddress: string, user: string, escrowSlot?: number): Promise<ZapV2Status | null> {
    requireBase58(vaultAddress, 'vault address');
    requireBase58(user, 'user wallet');
    // A wallet can hold up to 8 escrows per fund; without a slot the API
    // returns the oldest open one.
    const q = escrowSlot === undefined ? '' : `?slot=${escrowSlot}`;
    return this.authRequest<ZapV2Status | null>(
      `/vaults/${vaultAddress}/zap-v2/status/${user}${q}`,
    );
  }

  /**
   * `GET /portfolio` (auth) — the API reads the wallet from the JWT; there is NO
   * portfolio-by-arbitrary-address endpoint. So this returns the SESSION
   * wallet's positions. (To inspect another wallet you'd need that wallet's
   * keypair / session.)
   */
  async getPortfolioPositions(): Promise<unknown> {
    return this.authRequest<unknown>('/portfolio');
  }

  /** `GET /portfolio/summary` (auth) — total value + PnL for the session wallet. */
  async getPortfolioSummary(): Promise<unknown> {
    return this.authRequest<unknown>('/portfolio/summary');
  }

  /**
   * `GET /agent/operating` — the caller's operating wallet, or null.
   *
   * Doubles as the identity echo for the keyless lane: the response carries the
   * OWNER `wallet` the presented credential resolves to, which is the only
   * trustworthy answer when there is no local keypair to read a pubkey from.
   */
  async getOperatingWallet(): Promise<{ wallet?: string; operatingWalletAddress?: string; status?: string; policyUpdateRequired?: boolean } | null> {
    return this.authRequest('/agent/operating', { method: 'GET' });
  }

  /**
   * `POST /agent/operating/embedded/agent-wallet` — step 1 of headless app-wallet
   * creation: send ONLY the owner's P-256 public key. Session-only server-side,
   * so this always signs in with SIWS (a local keypair), never with DFM_API_KEY.
   */
  async beginAgentAppWallet(ownerPublicKey: string): Promise<AgentAppWalletStep> {
    return this.authRequest('/agent/operating/embedded/agent-wallet', {
      method: 'POST',
      body: JSON.stringify({ ownerPublicKey }),
      sessionOnly: true,
    });
  }

  /** Step 2: relay the owner's signature over the exact signer request step 1 returned. */
  async confirmAgentAppWallet(ownerPublicKey: string, signature: string): Promise<AgentAppWalletStep> {
    return this.authRequest('/agent/operating/embedded/agent-wallet/confirm', {
      method: 'POST',
      body: JSON.stringify({ ownerPublicKey, signature }),
      sessionOnly: true,
    });
  }

  /** `GET /profile` — human label for the authenticated identity. */
  /** Public profile of any trader, by wallet or username (social parity, 2026-10-09). */
  async getTraderProfile(by: { wallet?: string; username?: string }): Promise<unknown> {
    return by.username
      ? this.publicRequest(`/profile/u/${encodeURIComponent(by.username.replace(/^@/, ''))}`)
      : this.publicRequest(`/profile/${encodeURIComponent(by.wallet ?? '')}`);
  }

  /** Follow / unfollow a trader as the signed-in wallet. */
  async setFollowing(wallet: string, follow: boolean): Promise<unknown> {
    return this.authRequest(`/social/follow/${encodeURIComponent(wallet)}`, { method: follow ? 'POST' : 'DELETE' });
  }

  /**
   * `POST /bug-reports` → the team's /admin list. Sent with the wallet's session when
   * there is one; if the MCP cannot sign in (often the very bug being
   * reported) it is sent anonymously. Only an auth refusal falls back — any
   * other error may mean the report was already saved.
   */
  async reportBug(report: { title: string; description: string; context?: string; contact?: string }): Promise<unknown> {
    const init = { method: 'POST', body: JSON.stringify({ ...report, source: 'mcp' }) };
    try {
      return await this.authRequest('/bug-reports', init);
    } catch (e) {
      const msg = (e as Error).message;
      if (/^DFM API \d/.test(msg) && !/^DFM API (401|403)\b/.test(msg)) throw e;
      return this.publicRequest('/bug-reports', init);
    }
  }

  /** The caller's XP plus the top of the leaderboard. */
  async getXp(): Promise<unknown> {
    const [mine, leaderboard, rules] = await Promise.all([
      this.authRequest('/xp/me', { method: 'GET' }),
      this.publicRequest('/xp/leaderboard?limit=10'),
      this.publicRequest('/xp/rules'),
    ]);
    return { mine, leaderboard, rules };
  }

  async getProfile(): Promise<{ displayName?: string; username?: string } | null> {
    return this.authRequest('/profile', { method: 'GET' });
  }

  /**
   * `GET /agent/operating/float/balance` — the operating wallet's LIVE holdings.
   *
   * NOT the `float` field on the grant: that counts everything ever funded and
   * never decreases, so a spent wallet still reports its original top-up.
   * `withdrawableSolLamports` already excludes the rent-exempt floor the wallet
   * must keep, so it is the figure a caller can actually act on.
   */
  async getOperatingFloatBalance(): Promise<{
    operatingWalletAddress: string;
    status: string;
    // null = that onchain read failed on the server: UNKNOWN, never 0.
    solLamports: number | null;
    usdcMicros: number | null;
    reservedSolLamports: number | null;
    withdrawableSolLamports: number | null;
    withdrawableUsdcMicros: number | null;
  } | null> {
    return this.authRequest('/agent/operating/float/balance', { method: 'GET' });
  }

  /**
   * `POST /agent/operating/rearm` — supersede the current grant, mint a fresh one.
   *
   * DESTRUCTIVE IN ONE SPECIFIC WAY: the new grant is a NEW provider wallet with
   * a NEW ADDRESS and an empty float. Anything left in the old one stays there,
   * signable only by a sweep. Callers must withdraw first — the tool that wraps
   * this refuses while the float is non-zero for exactly that reason.
   */
  async rearmOperatingWallet(): Promise<{
    operatingWalletAddress?: string;
    status?: string;
  } | null> {
    return this.authRequest('/agent/operating/rearm', { method: 'POST', body: JSON.stringify({}) });
  }

  /**
   * `POST /agent/operating/float/withdraw` — sweep the float back to its OWNER.
   *
   * The agent never names a destination: the API resolves the owner's SAVED
   * withdrawal wallet first and falls back to the authenticated wallet, so
   * this cannot send anywhere else. Works past a stale rebalancer stamp and a
   * user expiry (the sweep carve-outs) — the float must never be trapped.
   */
  /**
   * `GET /agent/operating/assets` — every token the app wallet holds.
   *
   * The float endpoint answers USDC + SOL only, so a wallet holding DTF shares
   * or a swapped token could see nothing through it.
   */
  async listAppWalletAssets(): Promise<{
    assets?: Array<{
      mint: string;
      symbol?: string;
      amount?: string;
      uiAmount?: number;
      decimals?: number;
      usdValue?: number;
      isFundShare?: boolean;
    }>;
  } | null> {
    return this.authRequest('/agent/operating/assets');
  }

  /**
   * `POST /agent/operating/assets/withdraw` — move ONE mint back to the owner.
   *
   * An ADDRESS is deliberately NOT exposed here — an agent that could name
   * one would be a drain vector for anything that can put words in its input.
   * `to` (#124) only picks which of the owner's two wallets: the saved
   * withdrawal wallet (default; refused when none is saved) or the sign-in
   * wallet, when the human asked for it.
   */
  async withdrawAppWalletAsset(
    mint: string,
    amount?: number | string,
    to: 'saved' | 'sign_in_wallet' = 'saved',
  ): Promise<{ signature: string; sentAmount: string; mint: string } | null> {
    return this.authRequest('/agent/operating/assets/withdraw', {
      method: 'POST',
      body: JSON.stringify(
        // A digit string keeps raw amounts past 2^53 exact.
        amount === undefined ? { mint, all: true, to } : { mint, amount: String(amount), to },
      ),
    });
  }

  /**
   * `POST /agent/operating/swap/quote` — priced WITH the DFM platform fee, so
   * the figure an agent shows a user is the figure that arrives.
   */
  async quoteSwap(params: {
    inputMint: string;
    outputMint: string;
    amountRaw: string;
    slippageBps?: number;
  }): Promise<Record<string, unknown> | null> {
    return this.authRequest('/agent/operating/swap/quote', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * `POST /agent/operating/swap` — token→token out of the app wallet, routed
   * by Jupiter and signed server-side. NOT the zapper: no vault, no shares.
   */
  async swap(params: {
    inputMint: string;
    outputMint: string;
    amountRaw: string;
    slippageBps?: number;
  }): Promise<{ signature?: string; quote?: Record<string, unknown> } | null> {
    return this.authRequest('/agent/operating/swap', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** `to` as in `withdrawAppWalletAsset` (#124): one of the owner's two wallets, never an address. */
  async withdrawOperatingFloat(all = true, to: 'saved' | 'sign_in_wallet' = 'saved'): Promise<{
    signature?: string;
    sweptUsdcMicros?: number;
    sweptSolLamports?: number;
  } | null> {
    return this.authRequest('/agent/operating/float/withdraw', {
      method: 'POST',
      body: JSON.stringify({ all, to }),
    });
  }

  /**
   * `POST /agent/operating/float/fund/prepare` — the UNSIGNED owner→app-wallet
   * top-up. The OWNER signs this one: it is their money leaving their wallet,
   * which is the single signature the app-wallet model cannot avoid.
   */
  async prepareOperatingFund(amounts: {
    usdcMicros?: number;
    solLamports?: number;
  }): Promise<{
    transaction: string;
    blockhash: string;
    lastValidBlockHeight: number;
    operatingWalletAddress: string;
    /** Stamped by the global PreparedTxInterceptor on every `/prepare` response.
     *  Declaring it is what lets the caller use the BACKEND broadcast instead of
     *  demanding a client RPC — without it, funding was impossible for anyone who
     *  installed the MCP the documented one-line way (measured 2026-08-31: "No
     *  way to broadcast this signed tx: set HELIUS_RPC_URL"). */
    preparedTxId?: string;
  }> {
    return this.authRequest('/agent/operating/float/fund/prepare', {
      method: 'POST',
      body: JSON.stringify(amounts),
    }) as Promise<{
      transaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
      operatingWalletAddress: string;
      preparedTxId?: string;
    }>;
  }

  // ─── WRITE (keyless: the SERVER signs with the operating wallet) ────────

  /**
   * `POST /agent/operating/execute` — run a DFM write without any local key.
   *
   * The server builds the tx with the caller's Privy operating wallet as payer
   * and signs it behind both cap layers plus the tx-assert simulation. Used
   * when the MCP has an API key but no keypair; see `keyless.ts` for when that
   * applies and why it never falls back to local signing.
   *
   * The idempotency key is PINNED to the operation itself (tool + canonical
   * args, hashed) rather than a fresh UUID: when the response is lost — a 504
   * the server outlived, a dropped socket — the agent's retry carries the SAME
   * key, and the server returns the already-running/finished job instead of
   * executing a second time (the two-vaults-two-fees bug, A7).
   */
  async executeViaOperatingWallet(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ signature?: string; status: string; note?: string; vaultAddress?: string }> {
    const base = operatingOperationKey(tool, args);
    const now = Date.now();
    let op = this.unansweredOps.get(base);
    if (!op || now - op.at > OPERATION_RETRY_WINDOW_MS) {
      op = { key: `${base}-${randomUUID().slice(0, 8)}`, at: now };
      this.unansweredOps.set(base, op);
    }
    const first = await this.authRequest<
      | { signature?: string; status: string; note?: string; vaultAddress?: string }
      | { status: 'pending'; jobId: string; poll: string; note?: string }
    >('/agent/operating/execute', {
      method: 'POST',
      body: JSON.stringify({ tool, args }),
      idempotencyKey: op.key,
    });

    // Finished inside the server's inline window — the shape this method has
    // always returned. A result came back, so the next identical call is new.
    if (!('jobId' in first)) {
      this.unansweredOps.delete(base);
      return first;
    }

    // 202: the write outlives the gateway timeout and is still running. This is
    // the ONLY correct response to that — retrying the POST would execute the
    // write a SECOND time (a duplicate vault, the creation fee paid twice). A
    // poll that throws (failed, or still running) leaves the key for the retry.
    const done = await this.pollOperatingJob(first.jobId);
    this.unansweredOps.delete(base);
    return done;
  }

  /**
   * Poll a 202'd write to completion.
   *
   * `launch_vault` is three transactions with an on-chain propagation wait
   * between them; ~3 minutes of headroom covers it with room to spare. Timing
   * out here does NOT mean the write failed — it means we stopped watching — so
   * the message says so and hands back the job id rather than implying failure.
   */
  private async pollOperatingJob(
    jobId: string,
  ): Promise<{ signature?: string; status: string; note?: string; vaultAddress?: string }> {
    const INTERVAL_MS = 3_000;
    const MAX_ATTEMPTS = 60; // ~3 min

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      const job = await this.authRequest<{
        jobStatus: 'running' | 'done' | 'failed' | 'orphaned';
        signature?: string;
        execStatus?: string;
        note?: string;
        error?: string;
        errorStatus?: number;
        vaultAddress?: string;
      }>(`/agent/operating/execute/${jobId}`);

      if (job.jobStatus === 'running') continue;

      if (job.jobStatus === 'done') {
        return {
          ...(job.signature ? { signature: job.signature } : {}),
          status: job.execStatus ?? 'complete',
          ...(job.note ? { note: job.note } : {}),
          ...(job.vaultAddress ? { vaultAddress: job.vaultAddress } : {}),
        };
      }

      // A failure can still carry a LANDED signature (a later step failed after
      // an earlier one succeeded). Saying so is what stops a retry that would
      // duplicate real, already-spent work.
      throw new Error(
        `${job.errorStatus ? `DFM API ${job.errorStatus}: ` : ''}${job.error ?? 'the write failed'}` +
          (job.signature
            ? ` — but transaction ${job.signature} DID land. Reconcile onchain before retrying.`
            : ''),
      );
    }

    throw new Error(
      `the write is still running after ${(INTERVAL_MS * MAX_ATTEMPTS) / 1000}s. ` +
        `It has NOT failed — do not retry. Check GET /agent/operating/execute/${jobId}.`,
    );
  }

  // ─── WRITE (zap-v2 prepare endpoints) ──────────────────────────────────
  // These return UNSIGNED transactions. They do not move funds by themselves —
  // the agent must sign locally + submit. The MCP write tools gate these behind
  // DFM_AGENT_WRITE_ENABLED. The prepare calls themselves are auth-gated and
  // rate-limited (tx_prepare tier) server-side.
  // REVIEW: real-money path — parent must review before enabling.

  /** `POST /vaults/:address/zap-in-v2/open/prepare` — pull USDC, pin plan. */
  async prepareZapInOpenV2(
    vaultAddress: string,
    usdcAmountRaw: string,
    opts?: { slippageBps?: number; expirySecs?: number },
  ): Promise<ZapV2PrepareResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2PrepareResponse>(
      `/vaults/${vaultAddress}/zap-in-v2/open/prepare`,
      { method: 'POST', body: JSON.stringify({ usdcAmount: usdcAmountRaw, ...opts }) },
    );
  }

  /** `POST /vaults/:address/zap-in-v2/close/prepare` — CPI mint_in_kind_v2. */
  async prepareZapInCloseV2(vaultAddress: string, escrowSlot?: number): Promise<ZapV2PrepareResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2PrepareResponse>(
      `/vaults/${vaultAddress}/zap-in-v2/close/prepare`,
      { method: 'POST', body: JSON.stringify(escrowSlot === undefined ? {} : { escrowSlot }) },
    );
  }

  /**
   * `POST /tx/submit` (#18) — hand a SIGNED prepared tx back to the backend so
   * its premium RPC broadcasts it. Used when no client RPC is configured (the
   * one-line-install path). `preparedTxId` comes from the matching /prepare
   * response; the backend verifies the signed tx matches a prepare it issued to
   * this wallet, then broadcasts + confirms.
   */
  async submitSignedTx(
    preparedTxId: string,
    signedTxBase64: string,
  ): Promise<{ signature: string; confirmed: boolean }> {
    return this.authRequest<{ signature: string; confirmed: boolean }>('/tx/submit', {
      method: 'POST',
      body: JSON.stringify({ preparedTxId, signedTxBase64 }),
      // Pinned, NOT random: this is the call that BROADCASTS. `preparedTxId` is
      // the server's own id for exactly this transaction, so a retry of the same
      // submit replays the cached response instead of broadcasting a second time,
      // while a genuinely different submit necessarily carries a different id.
      idempotencyKey: `txsubmit-${preparedTxId}`,
    });
  }

  /** `POST /vaults/:address/zap-out-v2/open/prepare` — burn shares → escrow. */
  async prepareZapOutOpenV2(
    vaultAddress: string,
    sharesRaw: string,
    opts?: { slippageBps?: number; expirySecs?: number },
  ): Promise<ZapV2PrepareResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2PrepareResponse>(
      `/vaults/${vaultAddress}/zap-out-v2/open/prepare`,
      { method: 'POST', body: JSON.stringify({ shares: sharesRaw, ...opts }) },
    );
  }

  /** `POST /vaults/:address/zap-out-v2/close/prepare` — exit fee, pay net USDC. */
  async prepareZapOutCloseV2(vaultAddress: string, escrowSlot?: number): Promise<ZapV2PrepareResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2PrepareResponse>(
      `/vaults/${vaultAddress}/zap-out-v2/close/prepare`,
      { method: 'POST', body: JSON.stringify(escrowSlot === undefined ? {} : { escrowSlot }) },
    );
  }

  /**
   * `POST /vaults/:address/zap-v2/cancel/prepare` — return the escrow's current
   * USDC + per-asset balances to the test wallet as-is (no swaps, no oracle),
   * then close it. 404 server-side when no escrow is open. Single v0 tx.
   */
  async prepareZapCancelV2(vaultAddress: string, escrowSlot?: number): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/zap-v2/cancel/prepare`,
      { method: 'POST', body: JSON.stringify(escrowSlot === undefined ? {} : { escrowSlot }) },
    );
  }

  /**
   * `POST /vaults/:address/zap-v2/update-envelope/prepare` — LOOSEN the pinned
   * per-leg floors + slippage (and optionally extend expiry) so a stalled escrow
   * can complete. Monotonic loosening is enforced on-chain; the API rejects any
   * non-positive `newMinOuts`. Single v0 tx.
   */
  async prepareUpdateEnvelopeV2(
    vaultAddress: string,
    body: {
      newMinOuts: string[];
      newSlippageBps: number;
      newMinUsdcOut?: string;
      extendSecs?: number;
    },
  ): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/zap-v2/update-envelope/prepare`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  // ─── WRITE (create / launch a DTF) ─────────────────────────────────────
  // The create flow is prepare → sign locally → submit → confirm. Mirrors the
  // zap-v2 write gating (DFM_AGENT_WRITE_ENABLED). The prepare is auth-gated +
  // rate-limited (tx_prepare tier) server-side; the authed JWT wallet is the
  // vault creator/admin (body-supplied wallet is ignored by the API).
  // REVIEW: real-money path — parent must review before enabling.

  /**
   * `POST /vaults/create/prepare` — build the on-chain `create_vault` tx. The
   * creator is the SESSION wallet (from the JWT), not a body field. Returns a
   * single unsigned v0 tx + the `vaultAddress` PDA + a server-built ALT.
   */
  async prepareCreateVault(params: {
    name: string;
    symbol: string;
    dtfType: 'index';
    category: number;
    assets: CreateAssetInput[];
    description?: string;
    tags?: number[];
    /** Let DFM announce this fund publicly on X/Telegram/Moltbook (default false). */
    announceOptIn?: boolean;
  }): Promise<CreatePrepareResponse> {
    return this.authRequest<CreatePrepareResponse>('/vaults/create/prepare', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * `POST /vaults/create/confirm` — record the vault doc after the create tx
   * confirms. Only `signature` + `vaultAddress` are authoritative; the API reads
   * the economic params back from its prepare-cache (so they can't be tampered
   * post-prepare). MUST be called inside the cache TTL (~15 min).
   */
  async confirmCreateVault(
    signature: string,
    vaultAddress: string,
  ): Promise<CreateConfirmResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<CreateConfirmResponse>('/vaults/create/confirm', {
      method: 'POST',
      body: JSON.stringify({ signature, vaultAddress }),
      // The landed tx signature IS this record's identity — one signature can
      // only ever record one vault, so a retried confirm must not be a new op.
      // Truncated to stay inside the server's 8-128 char bound.
      idempotencyKey: `createconfirm-${signature.slice(0, 60)}`,
    });
  }

  // ─── WRITE (vault manager actions) ─────────────────────────────────────

  /**
   * `POST /vaults/:address/assets/prepare` (vault admin) — build an
   * `update_vault_assets` FULL-REPLACE basket tx. The API enforces the same
   * guards as the chain (manual mode, config timing, Σ bps == 10000, no dupes,
   * ≤10 in the current product) → clean 4xx instead of a chain revert.
   */
  async prepareUpdateAssets(
    vaultAddress: string,
    assets: CreateAssetInput[],
  ): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/assets/prepare`,
      { method: 'POST', body: JSON.stringify({ assets }) },
    );
  }

  /** `POST /vaults/:address/assets/confirm` — record the basket change post-broadcast. */
  async confirmUpdateAssets(
    vaultAddress: string,
    signature: string,
  ): Promise<{ status: string; signature: string }> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<{ status: string; signature: string }>(
      `/vaults/${vaultAddress}/assets/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ signature }),
        // Same rule as create/confirm — keyed on the landed signature. The
        // prefix matters: the server's idempotency key does NOT include the
        // path, so a bare signature would collide with create/confirm.
        idempotencyKey: `assetsconfirm-${signature.slice(0, 60)}`,
      },
    );
  }

  /**
   * `POST /vaults/:address/metadata/prepare` (vault admin) — board #47: build the
   * creator-signed `create_vault_metadata` follow-up tx that attaches Metaplex
   * name/symbol/uri to the share mint. Run after create_vault confirms; idempotent
   * (a 2nd call reverts, treated as already-done).
   */
  async prepareCreateVaultMetadata(
    vaultAddress: string,
  ): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/metadata/prepare`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }

  /**
   * `POST /vaults/:address/transfer-admin` (vault admin) — initiate transferring
   * vault admin to `newAdmin` (the new admin must ACCEPT separately). HIGH
   * sensitivity — gates the agent's `transfer_admin` tool.
   */
  async prepareTransferAdmin(
    vaultAddress: string,
    newAdmin: string,
  ): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    requireBase58(newAdmin, 'new admin wallet');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/transfer-admin`,
      { method: 'POST', body: JSON.stringify({ newAdmin }) },
    );
  }

  /** Build the transaction signed by the pending admin to complete a handoff. */
  async prepareAcceptAdminTransfer(
    vaultAddress: string,
  ): Promise<ZapV2SingleTxResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse>(
      `/vaults/${vaultAddress}/transfer-admin/accept/prepare`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }

  /** Verify a landed acceptance and reconcile the authoritative admin into Mongo. */
  async confirmAcceptAdminTransfer(
    vaultAddress: string,
    signature: string,
  ): Promise<{ status: string; signature: string; vaultAdmin: string }> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<{ status: string; signature: string; vaultAdmin: string }>(
      `/vaults/${vaultAddress}/transfer-admin/accept/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ signature }),
        idempotencyKey: `adminacceptconfirm-${signature.slice(0, 60)}`,
      },
    );
  }

  /**
   * `POST /rebalance/:vault/init/prepare` — prepare a creator-signed
   * `initialize_rebalancer` TX for a vault the test wallet ADMINS. Enables
   * rebalancing (the creator pays the RebalancerConfig rent — Top H-03). New
   * vaults launched by this agent already get this bundled into create; use this
   * for an older vault, an `enableRebalancer:false` create, or an oversized basket
   * whose create TX couldn't bundle it. 403 if the caller is not the vault admin.
   */
  async prepareInitRebalancer(
    vaultAddress: string,
  ): Promise<ZapV2SingleTxResponse & { rebalancerConfig?: string }> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ZapV2SingleTxResponse & { rebalancerConfig?: string }>(
      `/rebalance/${vaultAddress}/init/prepare`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }

  /**
   * #57 — `POST /rebalance/:vault/to-targets/prepare` (vault admin). Derive the
   * converging legs from the vault's CURRENT on-chain config targets vs live
   * holdings (the admin supplies NO in/out/amount) and return them as ordered
   * admin-signed `execute_rebalance` txs. Config is the single source of truth —
   * this only moves holdings toward the already-registered weights.
   */
  async prepareRebalanceToTargets(
    vaultAddress: string,
    maxSlippageBps?: number,
  ): Promise<RebalanceToTargetsResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<RebalanceToTargetsResponse>(
      `/rebalance/${vaultAddress}/to-targets/prepare`,
      { method: 'POST', body: JSON.stringify(maxSlippageBps ? { maxSlippageBps } : {}) },
    );
  }

  /**
   * #57 — `POST /rebalance/:vault/reconfigure/prepare` (vault admin). Set NEW
   * targets then converge in one order-aware flow (drain removed→0 → set targets
   * → fund added/under-weight). Returns the ordered plan + pre-prepared drain txs.
   */
  async prepareReconfigure(
    vaultAddress: string,
    targets: ReconfigureTargetInput[],
    maxSlippageBps?: number,
  ): Promise<ReconfigureResponse> {
    requireBase58(vaultAddress, 'vault address');
    return this.authRequest<ReconfigureResponse>(
      `/rebalance/${vaultAddress}/reconfigure/prepare`,
      { method: 'POST', body: JSON.stringify({ targets, ...(maxSlippageBps ? { maxSlippageBps } : {}) }) },
    );
  }
}
