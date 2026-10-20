# Security

`@dfm-fi/agent` drives real money on Solana mainnet. If you find a way to make it move funds a user did not approve, leak an API key, or bypass `DFM_AGENT_WRITE_ENABLED` / `DFM_MCP_CONFIRM_REQUIRED`, report it privately through GitHub's **"Report a vulnerability"** button on this repository (Security tab → Advisories). Don't open a public issue.

What this server never does: ask for, read or store a private key or seed phrase on the DFM path. Fund operations run through the user's app wallet; the API key is read-only by default and revocable at https://app.dfm.finance → Agent → Keys.

Risks of the protocol itself (contracts, protocol powers, custody of the app wallet) are documented at https://app.dfm.finance/docs/security.
