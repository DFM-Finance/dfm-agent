/**
 * The onboarding calls (profile, avatar, API key), always over the SIWS
 * session — never DFM_API_KEY: a key cannot mint a key (`/agent/keys` is
 * session-only) and a read-only key cannot write a profile. Kept beside
 * `DfmApiClient` rather than inside it; same contract as its SIWS lane:
 * Bearer token, one transparent re-auth on 401, an `X-Idempotency-Key` on
 * every write, the API's error text surfaced verbatim.
 */
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from './config.js';
import type { SiwsSession } from './session.js';

export type SessionFetch = (path: string, init: RequestInit & { json?: unknown }) => Promise<Record<string, unknown>>;

/**
 * Review S16/S17: when DFM_API_KEY is set, the key's owner and the SIWS
 * keypair must be the SAME wallet, or the session lane would act as a
 * different identity than the rest of the MCP. The owner comes from
 * `GET /agent/operating/embedded/agent-wallet/owner` over the KEY lane (answers for any key, read-only included, and
 * always carries `wallet`). FAIL CLOSED: an error or an unknown owner refuses.
 * A passing check is cached for the process; a failing one is retried.
 */
export function makeIdentityGuard(
  keyOwner: () => Promise<{ wallet?: unknown } | null | undefined>,
  siwsWallet: () => string,
  hasApiKey: () => boolean = () => Boolean(process.env.DFM_API_KEY?.trim()),
): () => Promise<void> {
  let ok: Promise<void> | null = null;
  return () => {
    if (!hasApiKey()) return Promise.resolve();
    ok ??= (async () => {
      let owner: unknown;
      try {
        owner = (await keyOwner())?.wallet;
      } catch (e) {
        throw new Error(`cannot verify whose DFM_API_KEY this is (${(e as Error).message}); refusing to act`);
      }
      if (typeof owner !== 'string' || !owner) throw new Error('cannot verify whose DFM_API_KEY this is; refusing to act');
      const me = siwsWallet();
      if (owner !== me) {
        throw new Error(`DFM_API_KEY belongs to ${owner}, not this keypair (${me}); use one identity (unset one of them)`);
      }
    })().catch((e) => {
      ok = null;
      throw e;
    });
    return ok;
  };
}

/**
 * The identity guard's owner lookup, over the KEY lane on purpose (review
 * S19): `X-DFM-Key`, never the SIWS bearer, against the route that answers
 * for any key (read-only included) even when the owner has no app wallet.
 * Errors throw — the guard turns them into a refusal (fail closed).
 */
export function makeKeyOwnerLookup(
  config: Pick<AgentConfig, 'apiUrl'>,
  apiKey: () => string | undefined = () => process.env.DFM_API_KEY?.trim(),
  doFetch: typeof fetch = fetch,
): () => Promise<{ wallet?: unknown }> {
  return async () => {
    const key = apiKey();
    if (!key) throw new Error('no DFM_API_KEY to look up');
    const res = await doFetch(`${config.apiUrl}/agent/operating/embedded/agent-wallet/owner`, {
      method: 'GET',
      headers: { 'X-DFM-Key': key },
    });
    if (!res.ok) throw new Error(`owner lookup answered ${res.status}`);
    return (await res.json()) as { wallet?: unknown };
  };
}

export function makeSessionFetch(
  config: Pick<AgentConfig, 'apiUrl'>,
  session: Pick<SiwsSession, 'getAccessToken'>,
  doFetch: typeof fetch = fetch,
  beforeEach: () => Promise<void> = async () => undefined,
): SessionFetch {
  return async (path, { json, ...init }) => {
    await beforeEach();
    const method = (init.method ?? 'GET').toUpperCase();
    const idem = method === 'GET' ? {} : { 'X-Idempotency-Key': randomUUID() };
    const send = (token: string) =>
      doFetch(`${config.apiUrl}${path}`, {
        ...init,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        headers: {
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...idem,
          Authorization: `Bearer ${token}`,
        },
      });
    let res = await send(await session.getAccessToken());
    if (res.status === 401) res = await send(await session.getAccessToken(true));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DFM API ${res.status} on ${path}: ${body.slice(0, 400)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  };
}

export function onboardingApi(call: SessionFetch) {
  return {
    getProfile: () => call('/profile', { method: 'GET' }) as Promise<{ wallet?: string; displayName?: string; effectiveAvatarUri?: string | null }>,
    updateProfile: (dto: { displayName: string; bio?: string }) => call('/profile', { method: 'PUT', json: dto }),
    uploadAvatar: (bytes: Buffer, filename: string, mime: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
      return call('/profile/avatar', { method: 'POST', body: form });
    },
    createApiKey: (body: Record<string, unknown>) => call('/agent/keys', { method: 'POST', json: body }),
    /** Owner-signed actions (agent-owned wallets): build → the MCP decodes + signs → submit. */
    prepareOwnerAction: (input: Record<string, unknown>) =>
      call('/agent/operating/embedded/agent-wallet/owner-request', { method: 'POST', json: input }),
    submitOwnerAction: (requestId: string, signature: string) =>
      call('/agent/operating/embedded/agent-wallet/owner-request/submit', { method: 'POST', json: { requestId, signature } }) as Promise<{ signature?: string }>,
    revokeApiKey: (id: string) => call(`/agent/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}
