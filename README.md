# synergy-mcp

Cross-stack dev-audit MCP server for the [Print With Synergy](https://printwithsynergy.com)
stack.

Serves four tools over the MCP stdio transport, scoped to the six repos in the
stack — `codex-pdf`, `lint-pdf`, `lens-pdf`, `compile-pdf`, `synergy`, `platform`:

| Tool                 | What it answers                                                       |
| -------------------- | --------------------------------------------------------------------- |
| `blast_radius`       | Who breaks if I change this symbol / route / env var?                 |
| `floor_pin_grid`     | Which repo pins which org package, at which version?                  |
| `pattern_audit`      | Which repos have CI / consume-surface / RFC 7807 / deep CLAUDE.md? |
| `stack_health_grid`  | What does `/healthz` + `/v1/contract` say across the prod URLs?       |

Built to close gaps the cross-stack architecture audit surfaced — pin drift,
pattern divergence, "lens vs lens-server" naming collisions, ad-hoc health
endpoint shapes.

## Install

```bash
npm install -g @printwithsynergy/synergy-mcp
# or use npx directly from your MCP client config
```

## Configure

The server needs to know where your six repo working trees live. Two ways:

### 1. Stack root (recommended)

If you clone every repo into a single parent directory:

```bash
export SYNERGY_MCP_STACK_ROOT=$HOME/code/printwithsynergy
# expects $HOME/code/printwithsynergy/{codex-pdf,lint-pdf,lens-pdf,compile-pdf,synergy,platform}
```

### 2. Per-repo overrides

For non-uniform paths:

```bash
export SYNERGY_MCP_PATH_CODEX_PDF=/path/to/codex-pdf
export SYNERGY_MCP_PATH_LINT_PDF=/path/to/lint-pdf
# ... one per repo
```

Per-repo env wins over `SYNERGY_MCP_STACK_ROOT` for the same repo. Repos that
don't resolve are simply skipped — tools return rows for whatever is available
plus a `notes[]` entry naming the missing repo.

### Prod URLs (for `stack_health_grid` only)

Defaults match the production hostnames the audit catalogued; override per
service:

```bash
export SYNERGY_MCP_URL_CODEX_PDF=https://codex.lintpdf.com
export SYNERGY_MCP_URL_LINT_PDF=https://lintpdf.com
export SYNERGY_MCP_URL_COMPILE_PDF=https://compilepdf.com
export SYNERGY_MCP_URL_SYNERGY=https://...        # not set by default
export SYNERGY_MCP_URL_PLATFORM=https://...       # not set by default
# lens-pdf has no HTTP surface (npm library only) — no URL needed.
```

## Use from Claude Code

Add to your Claude Code MCP config (`~/.config/claude-code/mcp.json` or
project-local equivalent):

```json
{
  "mcpServers": {
    "synergy-mcp": {
      "command": "npx",
      "args": ["-y", "@printwithsynergy/synergy-mcp"],
      "env": {
        "SYNERGY_MCP_STACK_ROOT": "/Users/you/code/printwithsynergy"
      }
    }
  }
}
```

Tools then show up as `mcp__synergy_mcp__blast_radius`,
`mcp__synergy_mcp__floor_pin_grid`, etc.

## Tools

### `blast_radius`

```json
{
  "target": "CodexDocument",
  "kind": "symbol"
}
```

Kinds: `symbol` | `route` | `env_var`. Default `symbol`.

Returns per-hit `{ repo, file, line, text, kind }` where `kind` is one of
`import` | `usage` | `route` | `env`.

Implementation note: regex-based (Python `from X import Y`, TS
`import { Y } from 'X'`, plus bare-name usage). Not AST.
[`ctxo`](https://github.com/anthropics/code-review-graph) ships a real AST
backed blast-radius for TS/Go/C# but doesn't have a Python plugin yet; this
tool fills the gap with the working substitute that lint-pdf's `CLAUDE.md`
already calls out.

### `floor_pin_grid`

```json
{ "package": "codex-pdf" }
```

Or omit `package` to return rows for every detected org package.

Audit finding #2 — the bug it would have caught on day one: lint-pdf pinning
`codex-pdf>=1.19.0` with no upper bound while compile-pdf pinned `<2.0`.

### `pattern_audit`

```json
{ "patterns": ["has_ci", "has_problem_details_errors"] }
```

Omit `patterns` to run every known probe. Each row is
`{ repo, pattern, present, evidence }`. Available patterns are listed in the
result's `available_patterns` field.

Probes are intentionally cheap (file existence, shallow grep). Audit findings
#1, #6, #13, and #4 each get a probe.

### `stack_health_grid`

```json
{ "timeout_ms": 5000 }
```

Optional `repos: ["codex-pdf", "synergy"]` to subset.

Each row: `{ repo, url, endpoint, status, latency_ms, body_summary }`. Endpoint
mapping per repo matches audit finding #15.

## Develop

```bash
pnpm install
pnpm dev                    # tsx watch
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run
pnpm build                  # tsc → dist/
```

## License

AGPL-3.0-or-later, matching the rest of the printwithsynergy engine stack.
