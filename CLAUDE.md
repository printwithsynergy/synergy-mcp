# synergy-mcp — agent notes

## Scope

Cross-stack dev-audit MCP server. Surfaces the patterns the cross-
stack architecture audit found inconsistently applied across the six
printwithsynergy repos (codex-pdf, lint-pdf, lens-pdf, compile-pdf,
synergy, platform) as four MCP tools over stdio.

**Non-goals:**
- Don't replace observability — `stack_health_grid` is a snapshot
  probe, not a tracing stack.
- Don't replace code review — the engine work happens in CodeRabbit
  + BugBot + human review.
- Don't replace JSON Schema / Spectral — `synergy` already enforces
  its OpenAPI contract.

## Architecture

- **stdio MCP transport.** Runs as a child process spawned by the
  client (Claude Code, Cline, etc.). Speaks the MCP protocol over
  stdin/stdout. No HTTP listener.
- **Read-only.** Every tool reads working trees and / or HTTP probes
  prod URLs. The server never writes to disk and never mutates a
  repo. If a tool needs persistence, store it in the MCP client's
  state, not here.
- **Configuration via env vars only.** No config file. The runtime is
  the user's shell; the MCP client passes env through the spawn.

## Tool surface

Four tools (`src/tools/*.ts`):

- `blast_radius` — regex-based call-site discovery. Python `from X
  import Y` + TS `import { Y } from 'X'` + bare-name usage. Pure
  filesystem scan, no AST.
- `floor_pin_grid` — parse `pyproject.toml#dependencies` and
  `package.json#{dependencies,devDependencies,peerDependencies}` for
  the org-package allowlist (`ORG_PACKAGES` in
  `src/tools/floor-pin-grid.ts`).
- `pattern_audit` — file-existence + shallow-grep probes. Each probe
  is a one-function file-system call; no AST.
- `stack_health_grid` — parallel `fetch` to per-repo health endpoints
  (the five different shapes catalogued by audit finding #15).

Adding a new tool:

1. Create `src/tools/<name>.ts` with `<Name>Input = z.object({...})`
   and `<name>(input)` function.
2. Add to the `TOOLS` array in `src/index.ts`.
3. Add to the README's tool table.
4. Add a test under `src/tools/<name>.test.ts`.

## Patterns + invariants

- **No exception leaks past the tool boundary.** Every tool catches
  its own errors and returns `{notes: [...]}` entries that explain
  what failed. The MCP server's tool-call handler maps unexpected
  throws into `isError: true` content blocks.
- **Tools return `{rows: [...], notes: [...]}`** as the response
  shape. Rows are the data; notes are configuration / partial-result
  warnings the caller might want to surface to the user.
- **Repo-name vocabulary** is fixed at `KNOWN_REPOS` in
  `src/config.ts`. Don't sprinkle string literals — go through the
  type.
- **No network calls outside `stack_health_grid`.** The other three
  tools must work fully offline. Don't add a "phone home for fresh
  Pantone data" feature; this is a dev tool, not a runtime.

## Configuration model

The user supplies repo paths via env. `src/config.ts` resolves them
in priority order:

1. `SYNERGY_MCP_PATH_<REPO>` (per-repo).
2. `SYNERGY_MCP_STACK_ROOT` + repo name (uniform layout).

Repos that don't resolve are silently skipped — tools still run on
the available subset and emit a note. **Never** throw because a repo
is missing; the OSS dev story is "configure incrementally."

For prod URLs (`stack_health_grid`), the defaults are baked in
(`codex.lintpdf.com`, `lintpdf.com`, `compilepdf.com`); override via
`SYNERGY_MCP_URL_<REPO>`.

## Local dev

```bash
pnpm install
pnpm dev                    # tsx watch src/index.ts
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run
pnpm lint                   # biome check src
pnpm build                  # tsc → dist/
```

CI gate: biome + tsc + vitest.

## Release flow

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry (Keep-a-Changelog format).
3. Open + merge the bump PR.
4. Tag `vX.Y.Z` on `main`; the publish workflow takes it from there.

The npm package is published to `@printwithsynergy/synergy-mcp` with
public access.

## License

AGPL-3.0-or-later, matching the engine stack.

## Code review & blast-radius protocol

- Run code-review-graph impact tools on changed symbols before edits.
- Run `pnpm typecheck` + `pnpm test` before commit.
- CodeRabbit reviews PRs automatically; Cursor BugBot is the second
  opinion.
- Never disable the code-review-graph Launch Agent.
