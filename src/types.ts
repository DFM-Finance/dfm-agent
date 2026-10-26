/**
 * Shared types for agent responses.
 *
 * These mirror the LIVE DFM v2 API (`/api/v2`, NestJS) response shapes as
 * verified against https://app.dfm.finance — NOT the older zap-v1 shapes the
 * previous version of this file assumed. Key corrections vs the stale version:
 *   - vault identity field is `address` (base58 PDA), not `id`
 *   - name/symbol are `vaultName` / `vaultSymbol`
 *   - `tvl`, `totalSupply`, `totalAssets` are STRING-encoded (raw integers or
 *     decimal strings) — never assume `number`
 *   - basket lives in `underlyingAssets`, each `{ mint, allocationBps, ... }`
 *   - `GET /vaults/:address` wraps the doc under `{ vault, status, ... }`
 *   - `GET /portfolio` reads the wallet from the JWT (no address param)
 */

/** One basket leg as stored on the vault doc (`underlyingAssets[]`). */
export interface UnderlyingAsset {
  mint: string;
  /** Target weight in bps (sums to 10_000 across the basket). */
  allocationBps?: number;
  /** Some payloads also surface a live/current weight; optional. */
  currentBps?: number;
  symbol?: string;
  decimals?: number;
  /** Live USD weight (%), when the detail endpoint computes it. */
  weightPercent?: number;
}

/**
 * Vault list item as returned by `GET /vaults` (under `{ vaults: [...] }`).
 * Only the fields the agent surfaces are typed strictly; the rest are loose.
 */
export interface VaultListItem {
  address: string;
  vaultName: string;
  vaultSymbol: string;
  status?: 'active' | 'paused' | 'closed' | string;
  paused?: boolean;
  closed?: boolean;
  category?: string;
  /** STRING-encoded — raw USDC (6dp) or decimal string depending on endpoint. */
  tvl?: string | number;
  /** Share price as a number (USDC per share). */
  sharePrice?: number;
  /** null when the live factory read failed — see `feesUnavailable`. Never read null as 0. */
  entryFeeBps?: number | null;
  exitFeeBps?: number | null;
  feesUnavailable?: boolean;
  totalSupply?: string;
  totalShares?: string;
  totalDepositors?: number;
  underlyingAssets?: UnderlyingAsset[];
}

/** `GET /vaults` envelope. */
export interface VaultListResponse {
  vaults: VaultListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** `GET /vaults/:address` envelope (the vault doc is nested under `vault`). */
export interface VaultDetailResponse {
  vault: VaultListItem & Record<string, unknown>;
  status?: unknown;
  currentWeights?: unknown;
  deviations?: unknown;
  feeStructure?: FeeStructure;
}

/** `feeStructure` of `GET /vaults/:address`. Factory-global; null fields + `feesUnavailable` on a failed read. */
export interface FeeStructure {
  entryFeeBps: number | null;
  exitFeeBps: number | null;
  managementFeeBps?: number;
  creatorFeeRatioBps: number | null;
  platformFeeRatioBps: number | null;
  feesUnavailable?: boolean;
}

/**
 * Decoded `ZapEscrowV2` from `GET /vaults/:address/zap-v2/status/:user`.
 * Returns `null` when the user has no open escrow for that vault. Auth-gated:
 * the caller JWT wallet must equal `:user` (or be the vault admin).
 * `mode`: 0 = zap-in (deposit), 1 = zap-out (redeem).
 */
export interface ZapV2Status {
  escrowPda: string;
  /** Escrow slot 0..7 — a wallet can hold several escrows per fund. */
  escrowSlot?: number;
  vault: string;
  user: string;
  mode: number;
  state: number;
  nAssets: number;
  assetMints: string[];
  filledMask: number;
  legProgress: boolean[];
  legsFilled: number;
  legsTotal: number;
  /** True once every leg is cranked AND the escrow is in its terminal pre-close state. */
  readyToClose: boolean;
  legFailures: Array<{ count: number; lastError: string } | null>;
  openedAt: number;
  expiresAt: number;
  isExpired: boolean;
  slippageBps: number;
  plannedAmountIn: string[];
  minOuts: string[];
  actualOuts: string[];
  inputAmount: string;
  sharesIn: string;
  minSharesOut: string;
  minUsdcOut: string;
}

/**
 * Common HTTP shape for the zap-v2 user-signed boundary builders
 * (`zap-in-v2/open`, `zap-in-v2/close`, `zap-out-v2/open`, `zap-out-v2/close`).
 * `transactions` are base64-encoded v0 `VersionedTransaction`s sharing one
 * blockhash; the agent must sign EACH locally with the test keypair, then submit.
 */
export interface ZapV2PrepareResponse {
  transactions: string[];
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnits: number;
  escrowPda: string;
  /** Escrow slot (0..7) the tx acts on. */
  escrowSlot?: number;
  /** zap-out OPEN additionally returns these (redeem economics). */
  minUsdcOut?: string;
  expectedUsdc?: string;
  minOuts?: string[];
  /** #18 — backend-broadcast ids, parallel to `transactions`. Present when the
   *  API stamped them; lets the agent submit each leg via POST /tx/submit
   *  (no client RPC needed). Absent → use BYO `HELIUS_RPC_URL`. */
  preparedTxIds?: string[];
}

/** Single-tx cancel/update-envelope prepare shape. */
export interface ZapV2SingleTxResponse {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** #18 — backend-broadcast id for POST /tx/submit. */
  preparedTxId?: string;
}

/**
 * One basket leg as the create flow takes it. The API's `UnderlyingAssetDto`
 * requires `mint` + `symbol` + `mintBps` (target weight, bps). Phase 3
 * (oracle-free) dropped the per-asset Pyth binding — listing requires only
 * legacy-SPL + null freeze authority + matching decimals, so the agent supplies
 * no feed.
 */
export interface CreateAssetInput {
  mint: string;
  symbol: string;
  /** Target weight in bps; the basket must sum to 10_000. */
  mintBps: number;
}

/**
 * `POST /vaults/create/prepare` response. The create tx is a SINGLE v0
 * `VersionedTransaction` (base64 `transaction`). `vaultAddress` is the PDA the
 * vault will live at once the tx confirms — needed verbatim for `/create/confirm`.
 * A server-built per-create ALT (`altAddress`) is referenced by the tx.
 */
export interface CreatePrepareResponse {
  transaction: string;
  versioned: boolean;
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnits?: number;
  /** #18 — backend-broadcast id for POST /tx/submit (no client RPC needed). */
  preparedTxId?: string;
  vaultAddress: string;
  vaultMint: string;
  vaultIndex: number;
  altAddress: string;
}

/**
 * `POST /vaults/create/confirm` response. The API records the vault doc AFTER
 * the on-chain create tx has confirmed. The confirm MUST land inside the
 * prepare-cache TTL (~15 min) or it 400s ("Prepare session expired") — the
 * on-chain vault still exists, but the Mongo record won't be written.
 */
export interface CreateConfirmResponse {
  status: string;
  signature: string;
  vault: Record<string, unknown>;
}

/**
 * #57 — one converging leg returned by `POST /rebalance/:vault/to-targets/prepare`
 * (and the `drainTxs` of reconfigure). Each carries an UNSIGNED admin-signed
 * `execute_rebalance` tx the agent signs locally + submits in order.
 */
export interface ConvergeLegTx {
  kind: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  minOut: string;
  valueUsdc: number;
  slippageBps: number;
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** `POST /rebalance/:vault/to-targets/prepare` response. */
export interface RebalanceToTargetsResponse {
  vaultAddress: string;
  gavUsdc: number;
  converged: boolean;
  legCount: number;
  legs: ConvergeLegTx[];
  /** Top-level parallel tx array (= legs[].transaction). */
  transactions: string[];
  /** #18 backend-broadcast ids, parallel to `transactions`. Stamped by the API. */
  preparedTxIds?: string[];
  note: string;
}

/** One target for the reconfigure flow. */
export interface ReconfigureTargetInput {
  mint: string;
  symbol: string;
  allocationBps: number;
  price?: number;
  decimals?: number;
}

/** `POST /rebalance/:vault/reconfigure/prepare` response. */
export interface ReconfigureResponse {
  vaultAddress: string;
  gavUsdc: number;
  plan: {
    diff: { reweight: string[]; add: string[]; remove: string[]; isCompositionChange: boolean };
    steps: Array<Record<string, unknown>>;
    reweight: ConvergeLegTx[];
    maxSlippageBps: number;
    gavUsdc: number;
  };
  drainTxs: ConvergeLegTx[];
  /** Top-level parallel tx array (= drainTxs[].transaction). */
  transactions: string[];
  /** #18 backend-broadcast ids, parallel to `transactions`. Stamped by the API. */
  preparedTxIds?: string[];
  note: string;
}

/** SIWS nonce response (`POST /auth/nonce`). */
export interface NonceResponse {
  nonce: string;
  /** The EXACT message the wallet must sign — do not rebuild it client-side. */
  message: string;
}

/** SIWS sign-in response for a `native` client (`POST /auth/siws`). */
export interface NativeAuthTokens {
  accessToken: string;
  refreshToken: string;
  wallet: string;
  expiresIn: string;
}
