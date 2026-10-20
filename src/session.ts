/**
 * SIWS session manager — turns the local test keypair into an authenticated
 * Bearer session against the DFM v2 API.
 *
 * AUTH DESIGN (matches api/src/modules/auth):
 *   1. POST /auth/nonce { wallet }            → { nonce, message }
 *      The server BUILDS the exact `message` (domain-bound, nonce-embedded). The
 *      client must sign THAT string verbatim — it must not reconstruct it.
 *   2. sign `message` locally with the test keypair (Ed25519 → base58 sig)
 *   3. POST /auth/siws { wallet, signature, message, client: 'native' }
 *      → { accessToken, refreshToken, wallet, expiresIn }   (Bearer tokens)
 *   4. Subsequent calls send `Authorization: Bearer <accessToken>`.
 *   5. On 401 (token expired/rotated), re-run 1–3 once and retry.
 *
 * We use the `native` client surface (Bearer tokens in the body) rather than the
 * `web` surface (httpOnly cookies) because an MCP agent is not a browser and has
 * no cookie jar — Bearer is the correct programmatic path.
 *
 * The session caches the access token in-memory only (process lifetime). It is
 * never persisted, never logged, never returned through MCP.
 */
import type { AgentConfig } from './config.js';
import type { NonceResponse, NativeAuthTokens } from './types.js';
import { getTestWalletPubkey, signSiwsMessage } from './signing.js';

export class SiwsSession {
  private accessToken: string | null = null;
  private wallet: string | null = null;
  /** Epoch ms when the cached access token should be considered stale. */
  private expiresAtMs = 0;
  /**
   * In-flight sign-in promise — dedupes concurrent token requests so a burst of
   * parallel authed calls (or a StrictMode-style double fire) does NOT trigger
   * multiple SIWS round-trips (which churn nonces + can trip the /auth/siws
   * rate limit). The first caller signs in; the rest await the same promise.
   */
  private signInPromise: Promise<string> | null = null;

  constructor(private readonly config: AgentConfig) {}

  /** The authenticated wallet (test-wallet pubkey). Loads the keypair on first use. */
  get walletAddress(): string {
    if (!this.wallet) {
      this.wallet = getTestWalletPubkey(this.config);
    }
    return this.wallet;
  }

  /**
   * Return a valid Bearer access token, signing in (or refreshing) if needed.
   * `force` re-authenticates even if a cached token looks valid (used after a
   * 401 from a protected call).
   */
  async getAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.accessToken && now < this.expiresAtMs) {
      return this.accessToken;
    }
    // Coalesce concurrent sign-ins onto a single in-flight promise.
    if (this.signInPromise) return this.signInPromise;
    this.signInPromise = this.signIn().finally(() => {
      this.signInPromise = null;
    });
    return this.signInPromise;
  }

  private async signIn(): Promise<string> {
    const wallet = this.walletAddress;

    // Step 1 — nonce + server-built message.
    const nonceRes = await this.postJson<NonceResponse>('/auth/nonce', { wallet });
    if (!nonceRes?.message) {
      throw new Error('SIWS nonce response missing `message` — cannot sign in.');
    }

    // Step 2 — sign the EXACT message locally.
    const signature = signSiwsMessage(this.config, nonceRes.message);

    // Step 3 — exchange for Bearer tokens (native client surface).
    const tokens = await this.postJson<NativeAuthTokens>('/auth/siws', {
      wallet,
      signature,
      message: nonceRes.message,
      client: 'native',
    });

    if (!tokens?.accessToken) {
      throw new Error('SIWS sign-in succeeded but returned no accessToken.');
    }
    this.accessToken = tokens.accessToken;
    // Parse `expiresIn` (e.g. "1h") conservatively; default to a 5-min skew floor.
    this.expiresAtMs = Date.now() + this.parseExpiryMs(tokens.expiresIn) - 60_000;
    return this.accessToken;
  }

  private parseExpiryMs(expiresIn: string | undefined): number {
    if (!expiresIn) return 60 * 60 * 1000; // default 1h
    const m = /^(\d+)\s*([smhd])$/.exec(expiresIn.trim());
    if (!m) {
      const n = Number(expiresIn);
      return Number.isFinite(n) ? n * 1000 : 60 * 60 * 1000; // bare seconds, else 1h
    }
    const value = Number(m[1]);
    const unit = m[2];
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return value * mult;
  }

  /** POST helper used for the unauthenticated auth endpoints. */
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}
