/**
 * floor_pin_grid — return the version-pin matrix for org packages
 * across every configured repo.
 *
 * Audits Python `pyproject.toml` `dependencies = [...]` lists and
 * Node `package.json` `dependencies` + `devDependencies` +
 * `peerDependencies` for the known printwithsynergy package names.
 *
 * Audit finding #2 in the cross-stack audit caught lint-pdf pinning
 * `codex-pdf>=1.19.0` with no upper bound while compile-pdf pinned
 * `>=1.15.0,<2.0`. This tool surfaces that mismatch as a one-call
 * grid query.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KNOWN_REPOS, type RepoName, resolveAllRepoPaths } from "../config.js";

export const FloorPinGridInput = z.object({
  package: z
    .string()
    .optional()
    .describe(
      "Optional package-name filter (e.g. 'codex-pdf' or '@printwithsynergy/lens-pdf'). When omitted, returns rows for every detected org package across every repo.",
    ),
});

/** A single row in the grid. */
export interface FloorPinRow {
  repo: RepoName;
  package: string;
  spec: string;
  /** Which manifest file + section the pin came from. */
  source: string;
}

/** Known org package names worth surfacing in the grid. */
const ORG_PACKAGES = [
  "codex-pdf",
  "lint-pdf",
  "compile-pdf",
  "@printwithsynergy/codex-client",
  "@printwithsynergy/lens-pdf",
  "@printwithsynergy/client",
  "@printwithsynergy/synergy-mcp",
];

function isOrgPackage(name: string): boolean {
  return ORG_PACKAGES.includes(name);
}

/** Parse a single pyproject.toml `dependencies = [...]` entry.
 *
 * Hand-rolled rather than `[\\s\\S]*?\\]` regex because package specs
 * legitimately contain `]` (e.g. `uvicorn[standard]>=0.30.0`), which
 * a lazy regex would close on. We walk lines instead: find
 * `^dependencies = [`, then accumulate until `^]` at line start. */
function parsePyprojectDeps(repo: RepoName, root: string): FloorPinRow[] {
  const path = join(root, "pyproject.toml");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows: FloorPinRow[] = [];

  const lines = text.split("\n");
  let inDeps = false;
  for (const line of lines) {
    if (!inDeps) {
      if (/^dependencies\s*=\s*\[/.test(line)) inDeps = true;
      continue;
    }
    if (/^\]\s*$/.test(line)) break;
    // Match the package name + version spec inside quotes; the spec
    // may legitimately contain commas + < > = ~ ! characters.
    const m = line.match(/['"]([A-Za-z0-9_.\-]+)(\[[^\]]*\])?([<>=!~,][^'"]*)?['"]/);
    if (m?.[1]) {
      const name = m[1].trim();
      const spec = (m[3] ?? "").trim() || "(unpinned)";
      if (isOrgPackage(name)) {
        rows.push({
          repo,
          package: name,
          spec,
          source: "pyproject.toml#dependencies",
        });
      }
    }
  }
  return rows;
}

/** Parse package.json dep sections for org packages. */
function parsePackageJson(repo: RepoName, root: string): FloorPinRow[] {
  const path = join(root, "package.json");
  if (!existsSync(path)) return [];
  const rows: FloorPinRow[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      const block = parsed[section];
      if (block && typeof block === "object") {
        for (const [name, spec] of Object.entries(
          block as Record<string, string>,
        )) {
          if (isOrgPackage(name)) {
            rows.push({
              repo,
              package: name,
              spec,
              source: `package.json#${section}`,
            });
          }
        }
      }
    }
  } catch {
    // Malformed JSON — skip rather than throw; surface as empty rows.
  }
  return rows;
}

export interface FloorPinGridResult {
  rows: FloorPinRow[];
  notes: string[];
}

export async function floorPinGrid(
  input: z.infer<typeof FloorPinGridInput>,
): Promise<FloorPinGridResult> {
  const paths = resolveAllRepoPaths();
  const rows: FloorPinRow[] = [];
  const notes: string[] = [];

  for (const repo of KNOWN_REPOS) {
    const root = paths[repo];
    if (!root) {
      notes.push(
        `repo ${repo}: not configured (set SYNERGY_MCP_PATH_${repo
          .toUpperCase()
          .replace(/-/g, "_")} or SYNERGY_MCP_STACK_ROOT)`,
      );
      continue;
    }
    rows.push(...parsePyprojectDeps(repo, root));
    rows.push(...parsePackageJson(repo, root));
  }

  const filtered = input.package
    ? rows.filter((r) => r.package === input.package)
    : rows;

  return {
    rows: filtered.sort(
      (a, b) =>
        a.package.localeCompare(b.package) || a.repo.localeCompare(b.repo),
    ),
    notes,
  };
}
