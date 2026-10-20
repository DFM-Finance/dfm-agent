export interface OperatingWalletIdentity {
  wallet?: string;
  operatingWalletAddress?: string;
  status?: string;
}

export interface WalletIdentity {
  signInWallet: string | null;
  appWalletAddress: string | null;
  appWalletStatus: string | null;
  /** Wallet that signs/owns actions in the current credential mode. */
  actingWallet: string | null;
  /** Wallet whose DFM positions the authenticated portfolio endpoints return. */
  portfolioWallet: string | null;
  /** Backward-compatible alias for the DFM portfolio wallet. */
  primaryDfmWallet: string | null;
}

export interface WalletIdentityView extends WalletIdentity {
  wallet: string | null;
}

/**
 * Keep authentication and custody roles explicit. The fallback is the local
 * SIWS keypair; keyless callers instead receive their owner from the API key's
 * server-resolved operating-wallet record.
 */
export function buildWalletIdentity(
  operating: OperatingWalletIdentity | null,
  localSignInWallet: string | null,
): WalletIdentity {
  const signInWallet = operating?.wallet ?? localSignInWallet;
  const appWalletAddress = operating?.operatingWalletAddress ?? null;
  const portfolioWallet = appWalletAddress ?? signInWallet;
  return {
    signInWallet,
    appWalletAddress,
    appWalletStatus: operating?.status ?? null,
    // The external key authenticates and funds; fund writes never fall back to it.
    actingWallet: operating?.status === 'active' ? appWalletAddress : null,
    portfolioWallet,
    primaryDfmWallet: portfolioWallet,
  };
}

/** Preserve `whoami.wallet` as the wallet that actually signs in this mode. */
export function withActingWalletAlias(identity: WalletIdentity): WalletIdentityView {
  return { wallet: identity.actingWallet, ...identity };
}

/** Label portfolio results with the wallet whose positions were requested. */
export function withPortfolioWalletAlias(identity: WalletIdentity): WalletIdentityView {
  return { wallet: identity.portfolioWallet, ...identity };
}

/** An explicit owner wins; otherwise inspect the wallet that acts in this mode. */
export function resolveZapStatusWallet(
  identity: WalletIdentity,
  explicitWallet?: string,
): string | null {
  return explicitWallet ?? identity.appWalletAddress ?? identity.actingWallet;
}
