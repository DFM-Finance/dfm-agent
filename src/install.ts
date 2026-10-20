/**
 * `npx @dfm-fi/agent install` — one-command setup.
 *
 * Registers the DFM agent MCP server into Claude Code automatically (via the
 * `claude mcp add` CLI when it's on PATH), and always prints the exact commands
 * + the Claude Desktop config snippet as a copy-paste fallback. The whole point
 * is that a person can find ONE command on the landing page, paste it, and be
 * done — no manual JSON editing, no RPC key.
 *
 *   npx -y @dfm-fi/agent install                          # read-only tools
 *   npx -y @dfm-fi/agent install --write --api-key dfm_…  # RECOMMENDED — signs with
 *                                                          # YOUR Privy operating wallet,
 *                                                          # no keypair anywhere
 *   npx -y @dfm-fi/agent install --write --keypair PATH   # legacy — local throwaway key
 *
 * Flags:
 *   --write            also enable the WRITE tools (launch/deposit/redeem/manage)
 *   --api-key <key>    a `dfm_…` credential (mint one with POST /agent/keys from a
 *                       signed-in session). RECOMMENDED for --write: every write
 *                       routes through /agent/operating/execute and signs with
 *                       YOUR Privy-custodied operating wallet — no Solana keypair
 *                       ever touches this machine. Mutually exclusive with --keypair
 *                       (agent/src/keyless.ts: a keypair present always wins, so
 *                       passing both would silently ignore --api-key).
 *   --keypair <path>   absolute path to the throwaway test-wallet keypair json
 *                      (only meaningful with --write; if omitted AND no --api-key,
 *                      drop the key at ~/.config/dfm/agent-wallet.json and it's
 *                      picked up zero-config — legacy local-signing path)
 *   --name <name>      MCP server name in Claude (default: dfm)
 *   --dry-run          print what would run; don't execute / don't register
 */
import { spawnSync } from 'node:child_process';

const PKG = '@dfm-fi/agent';

interface InstallOpts {
  write: boolean;
  keypair?: string;
  apiKey?: string;
  /** The key came from the environment, so it was never in argv — keep it that
   *  way in everything we PRINT (an env reference, not the literal secret). */
  apiKeyFromEnv?: boolean;
  name: string;
  dryRun: boolean;
}

function parse(args: string[]): InstallOpts {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  // The API key is a live money credential. Passing it as `--api-key <key>` puts
  // it in argv — world-readable in `ps` on Linux and saved verbatim to shell
  // history. Reading it from the environment instead keeps it out of both
  // (`/proc/<pid>/environ` is owner-only), so `DFM_API_KEY=dfm_… npx -y
  // @dfm-fi/agent install --write` is the safer form. The flag still wins when
  // given, so nothing that works today stops working.
  const apiKey = get('--api-key') ?? (process.env.DFM_API_KEY?.trim() || undefined);
  return {
    write: args.includes('--write'),
    keypair: get('--keypair'),
    apiKey,
    apiKeyFromEnv: !get('--api-key') && Boolean(apiKey),
    name: get('--name') ?? 'dfm',
    dryRun: args.includes('--dry-run'),
  };
}

/** `dfm_…abcd` — enough to confirm WHICH key without reprinting the secret. */
function redact(key: string): string {
  return key.length <= 8 ? 'dfm_…' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** The env pairs (flat KEY, VALUE, KEY, VALUE…) this install grants — shared by
 *  the `claude mcp add` argv and the Desktop config snippet, so the two can
 *  never drift apart on what auth mode gets wired up. */
function envPairs(o: InstallOpts, forDisplay = false): [string, string][] {
  if (!o.write) return [];
  const pairs: [string, string][] = [['DFM_AGENT_WRITE_ENABLED', 'true']];
  // --api-key takes the credential path; --keypair takes the legacy local-signing
  // path. runInstall() already rejects passing both, so at most one applies here.
  if (o.apiKey) {
    // Printed output substitutes a shell reference for a key that arrived via
    // the environment: `claude mcp add … --env DFM_API_KEY=$DFM_API_KEY` still
    // works when pasted, and the secret never lands in the terminal scrollback.
    pairs.push([
      'DFM_API_KEY',
      forDisplay && o.apiKeyFromEnv ? '$DFM_API_KEY' : o.apiKey,
    ]);
  } else if (o.keypair) pairs.push(['DFM_AGENT_KEYPAIR_PATH', o.keypair]);
  return pairs;
}

/** The `claude mcp add …` argv that registers this package as an MCP server. */
function claudeAddArgs(o: InstallOpts, forDisplay = false): string[] {
  const env: string[] = [];
  for (const [k, v] of envPairs(o, forDisplay)) env.push('--env', `${k}=${v}`);
  // `-- npx -y @dfm-fi/agent@latest` is the server launch command. No subcommand
  // after the package name → cli.ts sees a non-TTY stdin (Claude pipes it) and
  // starts the stdio MCP server. The `@latest` tag is LOAD-BEARING: without it,
  // npx prefers any CACHED version and silently serves a stale build (the
  // "110-commits-behind" bug). `@latest` forces npx to re-resolve the registry's
  // latest dist-tag on every MCP start → the user always runs the newest publish.
  return ['mcp', 'add', o.name, ...env, '--', 'npx', '-y', `${PKG}@latest`];
}

function quote(args: string[]): string {
  return args.map((a) => (/[\s='"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

function claudeDesktopSnippet(o: InstallOpts): string {
  // Desktop reads a static JSON file — there is no shell to expand `$VAR`. When
  // the key came from the environment the user deliberately kept it out of
  // argv, so print a placeholder rather than undoing that by echoing it here;
  // they already have the value. A key passed as `--api-key` was on screen the
  // moment they typed it, so re-printing it costs nothing and keeps the snippet
  // directly pasteable.
  const env = Object.fromEntries(
    envPairs(o).map(([k, v]) =>
      k === 'DFM_API_KEY' && o.apiKeyFromEnv
        ? ([k, '<paste your dfm_ key here>'] as [string, string])
        : ([k, v] as [string, string]),
    ),
  );
  // `@latest` so npx always re-resolves to the newest publish (never a stale cache).
  const entry: Record<string, unknown> = { command: 'npx', args: ['-y', `${PKG}@latest`] };
  if (Object.keys(env).length) entry.env = env;
  return JSON.stringify({ mcpServers: { [o.name]: entry } }, null, 2);
}

function hasClaudeCli(): boolean {
  try {
    const r = spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export async function runInstall(args: string[]): Promise<void> {
  const o = parse(args);

  // The keypair path is stored as a `--env DFM_AGENT_KEYPAIR_PATH=<path>` pair;
  // an `=` in the path would corrupt the KEY=VALUE parse. Reject it clearly
  // rather than register a silently-broken env var. (Spaces are fine — spawnSync
  // takes an argv array, no shell, and the printed command is quoted.)
  if (o.keypair && o.keypair.includes('=')) {
    console.error('\n  Error: --keypair path must not contain an "=" character.\n');
    process.exit(1);
  }

  // Reject BOTH auth flags together rather than silently picking one: per
  // agent/src/keyless.ts, a keypair present ALWAYS wins over DFM_API_KEY, so a
  // user passing both would have --api-key silently ignored with no error —
  // exactly the confusing-default class of bug this flag exists to close.
  if (o.keypair && o.apiKey) {
    console.error(
      '\n  Error: --keypair and --api-key are mutually exclusive (a keypair, if present, ' +
        'always wins — --api-key would be silently ignored). Pick one; --api-key is RECOMMENDED.\n',
    );
    process.exit(1);
  }

  const addArgs = claudeAddArgs(o); // real values — spawned, never printed
  const manualCmd = `claude ${quote(claudeAddArgs(o, true))}`; // safe to print

  console.log(`\n  DFM agent — ${o.write ? 'FULL (read + real-money write)' : 'read-only'} install\n`);
  if (o.apiKey && o.apiKeyFromEnv) {
    console.log(`  Using DFM_API_KEY from the environment (${redact(o.apiKey)}).\n`);
  }

  if (o.dryRun) {
    console.log('  (--dry-run) would run:\n    ' + manualCmd + '\n');
    console.log('  Claude Desktop config:\n' + indent(claudeDesktopSnippet(o)) + '\n');
    return;
  }

  let registered = false;
  if (hasClaudeCli()) {
    console.log('  Found the `claude` CLI — registering the MCP server for Claude Code…\n');
    const r = spawnSync('claude', addArgs, { stdio: 'inherit', timeout: 60_000 });
    if (r.status === 0) {
      registered = true;
      console.log('\n  ✅ Registered as MCP server "' + o.name + '" in Claude Code.');
    } else {
      console.log('\n  ⚠️  Auto-register did not complete — use the manual command below.');
    }
  } else {
    console.log('  `claude` CLI not found on PATH — copy ONE of the options below.\n');
  }

  if (!registered) {
    console.log('\n  Claude Code (CLI) — run:\n    ' + manualCmd);
    console.log('\n  Claude Desktop — add to your claude_desktop_config.json:\n' + indent(claudeDesktopSnippet(o)));
  }

  // Next-steps + guardrails, always shown.
  console.log('\n  Next:');
  console.log('   • Restart Claude Code / Claude Desktop so it picks up the server.');
  console.log('   • Try: "list the DFM vaults" (read-only — works with no key).');
  if (o.write) {
    if (o.apiKey) {
      console.log('   • Writes sign with YOUR Privy operating wallet (no keypair on this machine).');
      console.log('     No active/funded operating wallet yet? Ask Kim, or see /account in the app.');
    } else if (!o.keypair) {
      console.log('   • WRITE is ON but no --api-key or --keypair was given. RECOMMENDED: re-run with');
      console.log('     --api-key dfm_… (mint one with POST /agent/keys, signed in) — no keypair, ever.');
      console.log('     Legacy fallback: drop a throwaway keypair json at ~/.config/dfm/agent-wallet.json.');
    } else {
      console.log('   • Legacy local-keypair signing: this machine holds real signing power over that');
      console.log('     wallet directly, with none of the operating wallet\'s caps/simulation/revoke.');
      console.log('     RECOMMENDED instead: --api-key dfm_… (mint one with POST /agent/keys).');
    }
    console.log('   • WRITE tools move REAL money on Solana mainnet and only ever act on');
    console.log('     the signed-in wallet\'s own funds. Use a throwaway wallet.');
  } else {
    console.log('   • To enable real-money tools later, re-run with: --write --api-key dfm_… (RECOMMENDED)');
  }
  console.log('\n  Docs: https://www.npmjs.com/package/' + PKG + '\n');
}

function indent(s: string): string {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}
