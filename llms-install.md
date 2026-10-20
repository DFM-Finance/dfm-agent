# Installing the DFM MCP server (for AI coding agents)

1. Requires Node.js ≥ 20.
2. Read-only (no key needed for public reads):
   `npx -y @dfm-fi/agent install`
3. With write tools (real money on Solana mainnet), ONLY if the user asks and provides a write-enabled key from https://app.dfm.finance → Agent → KEYS:
   `npx -y @dfm-fi/agent install --write --api-key dfm_...`
4. Generic MCP config:
```json
{ "mcpServers": { "dfm": { "command": "npx", "args": ["-y", "@dfm-fi/agent@latest"],
  "env": { "DFM_API_KEY": "dfm_...", "DFM_AGENT_WRITE_ENABLED": "false", "DFM_MCP_CONFIRM_REQUIRED": "1" } } } }
```
5. Verify: call the `whoami` tool. It reports the acting wallet and whether writes are enabled.
Never ask the user for a private key or seed phrase. This server never needs one.
