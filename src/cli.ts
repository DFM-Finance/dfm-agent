#!/usr/bin/env node
/**
 * @dfm-fi/agent — CLI entrypoint (the package `bin`).
 *
 * Dispatches between two very different uses of the SAME command:
 *
 *   1. As an MCP server (how Claude Code / Desktop launch it): no subcommand and
 *      stdin is a pipe (non-TTY) → start the stdio JSON-RPC server. This is the
 *      behaviour every existing `npx -y @dfm-fi/agent` registration depends on,
 *      so it MUST stay the default for non-TTY invocations.
 *
 *   2. As a human-run installer / helper (a person pasting the landing-page
 *      command into a terminal):
 *        npx -y @dfm-fi/agent install [--write --keypair <path>]
 *        npx -y @dfm-fi/agent help | version | serve
 *      A bare `npx @dfm-fi/agent` in an interactive terminal (TTY) prints help
 *      instead of hanging on a stdio server with no client attached.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInstall } from './install.js';

function version(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  console.log(`
  @dfm-fi/agent v${version()} — drive DFM v2 funds from an AI agent (MCP).

  INSTALL (one command — registers the MCP server for Claude Code/Desktop):
    npx -y @dfm-fi/agent install                           read-only tools
    npx -y @dfm-fi/agent install --write --api-key dfm_…  + real-money tools (RECOMMENDED —
                                                            signs with YOUR Privy operating
                                                            wallet, no keypair anywhere)
    npx -y @dfm-fi/agent install --write --keypair <path>  legacy — local throwaway key

  COMMANDS:
    install [--write] [--api-key <dfm_…>] [--keypair <abs>] [--name <n>] [--dry-run]
                      Register the MCP server (auto via the \`claude\` CLI when
                      present; always prints the manual command + Desktop config).
                      --api-key and --keypair are mutually exclusive.
    serve             Start the stdio MCP server explicitly.
    help              Show this help.
    version           Print the version.

  When launched by an MCP client (no args, piped stdin) this starts the stdio
  server automatically — that's what \`claude mcp add dfm -- npx -y @dfm-fi/agent\`
  uses. No Solana RPC key required.

  AUTH — two ways, in this order of preference:

   1. DFM_API_KEY=dfm_...           ← RECOMMENDED. No keypair on disk at all.
      Mint one with POST /agent/keys from a signed-in session. The key resolves
      server-side to your wallet plus that credential's caps, and is READ-ONLY
      until you explicitly widen it. Revoke it any time; revocation is instant.
      Prefer this: a leaked keypair IS the wallet, a leaked key is revocable.

   2. DFM_AGENT_KEYPAIR_PATH=... ← legacy. Signs a SIWS challenge with a local
      keypair (or drop it at ~/.config/dfm/agent-wallet.json). Use a throwaway
      wallet, never a wallet holding real funds.

  Read tools need neither. WRITE tools additionally need
  DFM_AGENT_WRITE_ENABLED=true — and with an API key, the credential itself must
  also have been granted write access (both must allow: the caps are ANDed).
`);
}

async function startMcpServer(): Promise<void> {
  // Lazy import so `install`/`help` never pay the cost of building the full
  // server (loadConfig, 14 tool registrations) and so importing this module
  // never auto-starts the server (mcp-server only auto-starts as an entrypoint).
  const m = await import('./mcp-server.js');
  await m.startServer();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? '').toLowerCase();

  switch (cmd) {
    case 'install':
    case 'setup':
    case 'add':
      await runInstall(args.slice(1));
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(version());
      return;
    case 'serve':
      await startMcpServer();
      return;
    case '':
      // Bare invocation: a human in a terminal gets help; an MCP client (which
      // pipes BOTH stdin and stdout for the JSON-RPC stream) gets the server.
      // Double-lock on stdin OR stdout being a TTY: stdin.isTTY alone is falsy
      // when a human redirects stdin (`… < /dev/null`, some npx/CI shells),
      // which would otherwise hang on a server with no client. A human in a
      // terminal always has a TTY stdout; an MCP client never does.
      if (process.stdin.isTTY || process.stdout.isTTY) {
        printHelp();
      } else {
        await startMcpServer();
      }
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
