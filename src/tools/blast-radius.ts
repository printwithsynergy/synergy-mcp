/**
 * blast_radius — given a target (symbol, HTTP route, or env var),
 * scan every configured repo's working tree and return the call
 * sites.
 *
 * V1 uses ripgrep-style regex matching tuned to the language of
 * each repo (Python vs TypeScript). It's not full AST analysis —
 * ctxo (https://github.com/anthropics/code-review-graph) does that
 * for TS/Go/C# but doesn't ship a Python plugin yet. Grep is the
 * working substitute that lint-pdf's CLAUDE.md already calls out.
 *
 * Three target kinds:
 *
 * 1. `symbol` — e.g. `CodexDocument`, `withTenant`. Matches Python
 *    `from X import Y` lines and TS `import { Y } from 'X'` lines,
 *    plus bare usage sites.
 * 2. `route` — e.g. `POST /v1/extract` or `/api/v1/jobs`. Matches
 *    quoted occurrences of the path in any source file.
 * 3. `env_var` — e.g. `LENS_SERVER_URL`, `STRIPE_SECRET_KEY`.
 *    Matches `process.env.X`, `process.env["X"]`, `os.getenv("X")`,
 *    `os.environ.get("X")`, `os.environ["X"]`, and YAML `X:` lines.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  KNOWN_REPOS,
  REPO_LANG,
  type RepoLang,
  type RepoName,
  resolveAllRepoPaths,
} from "../config.js";

export const BlastRadiusInput = z.object({
  target: z
    .string()
    .min(1)
    .describe(
      "What to search for. Examples: 'CodexDocument' (a symbol), '/v1/extract' (an HTTP route), 'LENS_SERVER_URL' (an env var). Use `kind` to disambiguate.",
    ),
  kind: z
    .enum(["symbol", "route", "env_var"])
    .default("symbol")
    .describe(
      "How to interpret `target`. 'symbol' matches import lines + bare usage. 'route' matches the path string as a quoted literal. 'env_var' matches process.env / os.environ / os.getenv access.",
    ),
  repos: z
    .array(z.string())
    .optional()
    .describe(
      "Optional subset of repos to search. When omitted, searches all configured repos.",
    ),
  max_results_per_repo: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe("Cap on hits per repo to keep the response bounded."),
});

export interface BlastRadiusHit {
  repo: RepoName;
  file: string;
  line: number;
  text: string;
  kind: "import" | "usage" | "route" | "env";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPatterns(
  target: string,
  kind: z.infer<typeof BlastRadiusInput>["kind"],
  lang: RepoLang,
): { kind: BlastRadiusHit["kind"]; re: RegExp }[] {
  const t = escapeRegex(target);
  if (kind === "env_var") {
    return [
      {
        kind: "env" as const,
        re: new RegExp(
          // TS: process.env.X, process.env['X'], process.env["X"]
          // Python: os.getenv("X"), os.environ["X"], os.environ.get("X")
          // YAML: X: value
          `(?:process\\.env(?:\\.${t}|\\[['"]${t}['"]\\]))|(?:os\\.getenv\\(['"]${t}['"]\\))|(?:os\\.environ(?:\\[['"]${t}['"]\\]|\\.get\\(['"]${t}['"]\\)))|(?:^\\s*${t}\\s*:)`,
          "m",
        ),
      },
    ];
  }
  if (kind === "route") {
    return [
      {
        kind: "route" as const,
        re: new RegExp(`['"\`]${t}['"\`]`),
      },
    ];
  }
  // symbol
  const patterns: { kind: BlastRadiusHit["kind"]; re: RegExp }[] = [];
  if (lang === "python") {
    patterns.push({
      kind: "import" as const,
      re: new RegExp(`^\\s*from\\s+\\S+\\s+import\\s+[^#]*\\b${t}\\b`, "m"),
    });
  } else {
    patterns.push({
      kind: "import" as const,
      re: new RegExp(
        `^\\s*import\\s+(?:[^;]*\\{[^}]*\\b${t}\\b[^}]*\\}|\\*\\s+as\\s+${t}|${t})`,
        "m",
      ),
    });
  }
  patterns.push({
    kind: "usage" as const,
    re: new RegExp(`\\b${t}\\b`),
  });
  return patterns;
}

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".yml",
  ".yaml",
]);

function isSearchable(name: string): boolean {
  return SOURCE_EXT.has(extname(name));
}

function walk(
  dir: string,
  onFile: (path: string) => boolean,
  depth = 0,
  maxDepth = 8,
): boolean {
  if (depth > maxDepth) return true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === "dist" ||
      name === "build" ||
      name === ".venv" ||
      name === "__pycache__" ||
      name === ".turbo" ||
      name === ".next"
    ) {
      continue;
    }
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const keepGoing = walk(full, onFile, depth + 1, maxDepth);
      if (!keepGoing) return false;
    } else if (s.isFile() && isSearchable(name)) {
      const keepGoing = onFile(full);
      if (!keepGoing) return false;
    }
  }
  return true;
}

function searchRepo(
  repo: RepoName,
  root: string,
  patterns: { kind: BlastRadiusHit["kind"]; re: RegExp }[],
  cap: number,
): BlastRadiusHit[] {
  const hits: BlastRadiusHit[] = [];
  walk(root, (file) => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return true;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const p of patterns) {
        if (p.re.test(line)) {
          hits.push({
            repo,
            file,
            line: i + 1,
            text: line.trim().slice(0, 300),
            kind: p.kind,
          });
          if (hits.length >= cap) return false;
          break;
        }
      }
    }
    return true;
  });
  return hits;
}

export interface BlastRadiusResult {
  target: string;
  kind: z.infer<typeof BlastRadiusInput>["kind"];
  hits: BlastRadiusHit[];
  notes: string[];
}

export async function blastRadius(
  input: z.infer<typeof BlastRadiusInput>,
): Promise<BlastRadiusResult> {
  const paths = resolveAllRepoPaths();
  const notes: string[] = [];
  const subset = input.repos
    ? (input.repos.filter((r) =>
        KNOWN_REPOS.includes(r as RepoName),
      ) as RepoName[])
    : KNOWN_REPOS;

  const allHits: BlastRadiusHit[] = [];
  for (const repo of subset) {
    const root = paths[repo];
    if (!root) {
      notes.push(`repo ${repo}: not configured`);
      continue;
    }
    const patterns = buildPatterns(input.target, input.kind, REPO_LANG[repo]);
    const hits = searchRepo(repo, root, patterns, input.max_results_per_repo);
    allHits.push(...hits);
  }

  return {
    target: input.target,
    kind: input.kind,
    hits: allHits,
    notes,
  };
}
