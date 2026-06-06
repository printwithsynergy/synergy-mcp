/**
 * Stack configuration.
 *
 * synergy-mcp serves a cross-stack dev-audit MCP over six repos in
 * the Print With Synergy stack. It needs to know where each repo's
 * working tree is on the host. Two ways to tell it:
 *
 * 1. Env vars (per-repo): SYNERGY_MCP_PATH_CODEX_PDF=/path/to/codex-pdf
 *    (...one per repo). Highest priority.
 * 2. Stack root env: SYNERGY_MCP_STACK_ROOT=/path/to/clones — assumes
 *    each repo is a sibling directory named after the repo. This is
 *    the common case when you clone all six into a single
 *    `printwithsynergy/` directory.
 *
 * If neither is set, the server starts but every tool returns an
 * empty result with a `config_missing` flag so the caller can prompt
 * the user to configure.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RepoName =
  | "codex-pdf"
  | "lint-pdf"
  | "lens-pdf"
  | "compile-pdf"
  | "synergy"
  | "platform";

export const KNOWN_REPOS: RepoName[] = [
  "codex-pdf",
  "lint-pdf",
  "lens-pdf",
  "compile-pdf",
  "synergy",
  "platform",
];

/** Language tag drives which AST / pattern set to use. */
export type RepoLang = "python" | "typescript";

export const REPO_LANG: Record<RepoName, RepoLang> = {
  "codex-pdf": "python",
  "lint-pdf": "python",
  "compile-pdf": "python",
  "lens-pdf": "typescript",
  synergy: "typescript",
  platform: "typescript",
};

/** Prod URLs for stack_health_grid. Override via env. */
export const PROD_URLS: Record<RepoName, string | null> = {
  "codex-pdf":
    process.env.SYNERGY_MCP_URL_CODEX_PDF ?? "https://codex.lintpdf.com",
  "lint-pdf": process.env.SYNERGY_MCP_URL_LINT_PDF ?? "https://lintpdf.com",
  "compile-pdf":
    process.env.SYNERGY_MCP_URL_COMPILE_PDF ?? "https://compilepdf.com",
  "lens-pdf": null, // npm library — no prod URL
  // synergy + platform are now live (jwt-only auth cutover complete); default
  // to their prod URLs so stack_health_grid probes them out of the box.
  synergy:
    process.env.SYNERGY_MCP_URL_SYNERGY ??
    "https://synergy-api-production.up.railway.app",
  platform:
    process.env.SYNERGY_MCP_URL_PLATFORM ??
    "https://platform.printwithsynergy.com",
};

/**
 * Map a RepoName to its env-var-friendly UPPERCASE_SNAKE form, e.g.
 * "codex-pdf" → "CODEX_PDF". Used to look up SYNERGY_MCP_PATH_<NAME>.
 */
function envKey(repo: RepoName): string {
  return repo.toUpperCase().replace(/-/g, "_");
}

/** Resolve the working-tree path for a single repo, or null. */
export function resolveRepoPath(repo: RepoName): string | null {
  const perRepoEnv = process.env[`SYNERGY_MCP_PATH_${envKey(repo)}`];
  if (perRepoEnv && existsSync(perRepoEnv)) return perRepoEnv;

  const stackRoot = process.env.SYNERGY_MCP_STACK_ROOT;
  if (stackRoot) {
    const guess = join(stackRoot, repo);
    if (existsSync(guess)) return guess;
  }

  return null;
}

/** Resolve all six repo paths. Missing repos appear as null. */
export function resolveAllRepoPaths(): Record<RepoName, string | null> {
  const result: Partial<Record<RepoName, string | null>> = {};
  for (const repo of KNOWN_REPOS) {
    result[repo] = resolveRepoPath(repo);
  }
  return result as Record<RepoName, string | null>;
}

/** True if any repo resolves; the caller can surface `config_missing`. */
export function hasAnyRepo(): boolean {
  return KNOWN_REPOS.some((r) => resolveRepoPath(r) !== null);
}
