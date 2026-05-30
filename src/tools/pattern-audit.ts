/**
 * pattern_audit — return the (repo × pattern) matrix for the patterns
 * the cross-stack audit found inconsistently applied.
 *
 * Each pattern has a probe function that decides {present, evidence}
 * for a given repo working tree. Patterns are intentionally cheap:
 * file-exists checks, regex matches against well-known manifests,
 * or directory presence. No AST.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KNOWN_REPOS, type RepoName, resolveAllRepoPaths } from "../config.js";

export const PatternAuditInput = z.object({
  patterns: z
    .array(z.string())
    .optional()
    .describe(
      "Optional subset of pattern names to evaluate. When omitted, evaluates all known patterns. See the description of `pattern` in each row for the full list.",
    ),
});

export interface PatternRow {
  repo: RepoName;
  pattern: string;
  present: boolean;
  evidence: string;
}

/** Each probe runs in a working tree root and returns its verdict. */
type Probe = (root: string) => { present: boolean; evidence: string };

const PROBES: Record<string, { description: string; probe: Probe }> = {
  has_ci: {
    description:
      "Repo has at least one .github/workflows/*.yml file. Audit finding #1 caught platform with zero workflows on main.",
    probe: (root) => {
      const dir = join(root, ".github", "workflows");
      if (!existsSync(dir))
        return { present: false, evidence: "no .github/workflows" };
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
      );
      return {
        present: files.length > 0,
        evidence: files.join(", ") || "(empty dir)",
      };
    },
  },

  has_openapi_contract_endpoint: {
    description:
      "Repo exposes a /v1/contract HTTP endpoint (the codex/compile convention).",
    probe: (root) => {
      const hits = grepFirst(root, /["']\/v1\/contract["']/, ["src", "apps"]);
      return hits
        ? { present: true, evidence: hits }
        : { present: false, evidence: "no /v1/contract reference" };
    },
  },

  has_consume_surface_audit: {
    description:
      "Repo has scripts/consume_surface_audit.py (compile-pdf's tripwire — banning re-implementation of an upstream's primitives).",
    probe: (root) => {
      const p = join(root, "scripts", "consume_surface_audit.py");
      return existsSync(p)
        ? { present: true, evidence: "scripts/consume_surface_audit.py" }
        : { present: false, evidence: "not present" };
    },
  },

  has_engine_purity_audit: {
    description:
      "Repo has scripts/check_engine_purity.sh (lint-pdf's tripwire — banning analyzer-side imports of host services).",
    probe: (root) => {
      const p = join(root, "scripts", "check_engine_purity.sh");
      return existsSync(p)
        ? { present: true, evidence: "scripts/check_engine_purity.sh" }
        : { present: false, evidence: "not present" };
    },
  },

  has_openapi_descriptions_audit: {
    description:
      "Repo has scripts/check_openapi_descriptions.py (lint-pdf's tripwire — every Pydantic Field must include description=).",
    probe: (root) => {
      const p = join(root, "scripts", "check_openapi_descriptions.py");
      return existsSync(p)
        ? { present: true, evidence: "scripts/check_openapi_descriptions.py" }
        : { present: false, evidence: "not present" };
    },
  },

  has_problem_details_errors: {
    description:
      "Repo emits RFC 7807 Problem Details (audit finding #13: the org-aligned target error envelope).",
    probe: (root) => {
      const hits = grepFirst(
        root,
        /problem[-_]?details|application\/problem\+json|rfc7807/i,
        ["src", "apps", "packages"],
      );
      return hits
        ? { present: true, evidence: hits }
        : { present: false, evidence: "no Problem Details reference" };
    },
  },

  has_claude_md_deep: {
    description:
      "CLAUDE.md is longer than 50 lines (a rough proxy for 'has architectural rules', not just process bullets).",
    probe: (root) => {
      const p = join(root, "CLAUDE.md");
      if (!existsSync(p)) return { present: false, evidence: "no CLAUDE.md" };
      const lines = readFileSync(p, "utf8").split("\n").length;
      return {
        present: lines >= 50,
        evidence: `${lines} lines`,
      };
    },
  },
};

/** Return all pattern names this tool knows. */
export function knownPatterns(): { name: string; description: string }[] {
  return Object.entries(PROBES).map(([name, p]) => ({
    name,
    description: p.description,
  }));
}

/** Walk a few top-level directories looking for the first match of `re`. */
function grepFirst(root: string, re: RegExp, dirs: string[]): string | null {
  for (const dir of dirs) {
    const p = join(root, dir);
    if (!existsSync(p)) continue;
    const hit = walkFirst(p, re, 0, 4);
    if (hit) return hit;
  }
  return null;
}

function walkFirst(
  dir: string,
  re: RegExp,
  depth: number,
  maxDepth: number,
): string | null {
  if (depth > maxDepth) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const sub = walkFirst(full, re, depth + 1, maxDepth);
      if (sub) return sub;
    } else if (
      s.isFile() &&
      /\.(ts|tsx|js|py|json|toml|yml|yaml|md)$/.test(name)
    ) {
      try {
        const text = readFileSync(full, "utf8");
        if (re.test(text)) {
          // Find the first line that hits
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line !== undefined && re.test(line)) {
              return `${full}:${i + 1}`;
            }
          }
          return full;
        }
      } catch {
        // ignore binary/unreadable
      }
    }
  }
  return null;
}

export interface PatternAuditResult {
  rows: PatternRow[];
  notes: string[];
  available_patterns: { name: string; description: string }[];
}

export async function patternAudit(
  input: z.infer<typeof PatternAuditInput>,
): Promise<PatternAuditResult> {
  const paths = resolveAllRepoPaths();
  const notes: string[] = [];
  const probesToRun = input.patterns ?? Object.keys(PROBES);

  const rows: PatternRow[] = [];
  for (const repo of KNOWN_REPOS) {
    const root = paths[repo];
    if (!root) {
      notes.push(`repo ${repo}: not configured`);
      continue;
    }
    for (const name of probesToRun) {
      const probe = PROBES[name];
      if (!probe) {
        notes.push(`pattern '${name}' is not known; ignored`);
        continue;
      }
      const result = probe.probe(root);
      rows.push({ repo, pattern: name, ...result });
    }
  }

  return { rows, notes, available_patterns: knownPatterns() };
}
