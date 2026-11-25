/**
 * The remote server's only door to DFM: the public HTTP API at ONE base URL
 * fixed at startup. Nothing a caller sends ever becomes a host or a URL: tool
 * arguments are path segments (validated base58 or percent-encoded) and query
 * values. Redirects are refused. The caller's own read-only `dfm_` key, when
 * they connect with one, is forwarded upstream as `X-DFM-Key`; the server holds no key of its own.
 */
import { randomUUID } from 'node:crypto';
import type { ListVaultsParams, ReadToolCtx } from '../read-tools.js';
import type { VaultDetailResponse, VaultListResponse } from '../types.js';

export const DEFAULT_API_URL = 'https://app.dfm.finance/api/v2';
export const CALLER_KEY = /^Bearer (dfm_[A-Za-z0-9_-]{8,200})$/;
const TIMEOUT_MS = 15_000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const NEEDS_KEY =
  'This tool reads your own account. Connect with your read-only DFM API key as the header ' +
  '`Authorization: Bearer dfm_…` (create one in the app, or with the local `@dfm-fi/agent` server). ' +
  'The other tools need no key.';

/**
 * Deliberately NOT `config.ts`'s `normalizeApiUrl`: the remote lane's import allowlist forbids
 * importing `config.ts` (it reads env and keypairs), so this lane keeps its own resolver. The rules
 * differ on purpose: `config.ts` takes a bare host (`https://app.dfm.finance`) and appends
 * `/api/v2` itself, while this one needs the FULL base including `/api/v2`
 * (`DEFAULT_API_URL`), enforces https (localhost excepted) and only trims trailing slashes.
 */
export function resolveApiUrl(raw: string | undefined): string {
  const url = new URL(raw?.trim() || DEFAULT_API_URL);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new Error('DFM_API_URL must be https');
  return url.toString().replace(/\/+$/, '');
}

export class RemoteReadClient implements ReadToolCtx {
  constructor(
    private readonly baseUrl: string,
    /** The caller's `Authorization` header value; only a `dfm_` bearer is ever kept. */
    authorization?: string,
  ) {
    this.key = authorization ? CALLER_KEY.exec(authorization)?.[1] : undefined;
  }
  private readonly key?: string;

  private async request<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {}): Promise<T> {
    if (init.auth && !this.key) throw new Error(NEEDS_KEY);
    const headers: Record<string, string> = { Accept: 'application/json' };
    // The API reads a `dfm_` credential from `X-DFM-Key`; `Authorization: Bearer dfm_…` is read as a JWT and
    // answers 401 (measured on production 2026-11-25). The caller's Bearer is MCP's convention, the upstream's is this header.
    if (init.auth) headers['X-DFM-Key'] = this.key as string;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Idempotency-Key'] = randomUUID();
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DFM API ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  listVaults(params: ListVaultsParams): Promise<VaultListResponse> {
    const q = new URLSearchParams();
    if (params.category !== undefined) q.set('category', String(params.category));
    for (const k of ['sortBy', 'sortDir', 'search', 'creator'] as const) if (params[k]) q.set(k, params[k]);
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return this.request(`/vaults${qs ? `?${qs}` : ''}`);
  }
  getVault(address: string): Promise<VaultDetailResponse> {
    return this.request(`/vaults/${encodeURIComponent(address)}`);
  }
  searchTokens(query: string, assetClass?: string): Promise<unknown> {
    const q = new URLSearchParams({ q: query });
    if (assetClass) q.set('class', assetClass);
    return this.request(`/assets/search?${q.toString()}`);
  }
  getTokenPrice(mint: string): Promise<unknown> {
    return this.request(`/prices/${encodeURIComponent(mint)}`);
  }
  getProtocolFacts(): Promise<unknown> {
    return this.request('/protocol/facts');
  }
  getTraderProfile(by: { wallet?: string; username?: string }): Promise<unknown> {
    return by.username
      ? this.request(`/profile/u/${encodeURIComponent(by.username.replace(/^@/, ''))}`)
      : this.request(`/profile/${encodeURIComponent(by.wallet ?? '')}`);
  }

  // The three below read the caller's own account: the API applies its own-only rules to the key.
  async zapStatus(a: { vault: string; user?: string; escrowSlot?: number }): Promise<unknown> {
    if (!a.user) throw new Error('Pass `user`: the wallet of the key you connected with.');
    if (!BASE58.test(a.vault) || !BASE58.test(a.user)) throw new Error('vault and user must be base58 addresses');
    const q = a.escrowSlot === undefined ? '' : `?slot=${a.escrowSlot}`;
    const res = await this.request(`/vaults/${a.vault}/zap-v2/status/${a.user}${q}`, { auth: true });
    return res ?? { escrow: null, note: 'No open zap-v2 escrow for this vault+user.' };
  }
  async portfolio(): Promise<unknown> {
    const [positions, summary] = await Promise.all([
      this.request('/portfolio', { auth: true }),
      this.request('/portfolio/summary', { auth: true }).catch(() => null),
    ]);
    return { positions, summary };
  }
  quoteSwap(p: { inputMint: string; outputMint: string; amountRaw: string; slippageBps?: number }): Promise<unknown> {
    return this.request('/agent/operating/swap/quote', { method: 'POST', body: p, auth: true });
  }
}
