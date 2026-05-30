/**
 * stack_health_grid — fetch /healthz (and /v1/contract when available)
 * across the configured prod URLs for the stack, in parallel, and
 * return a grid with status code + latency + version skew.
 *
 * Audit finding #15 in the cross-stack audit caught five different
 * health/contract endpoint patterns. This tool branches per-service
 * so the caller doesn't have to.
 */
import { z } from "zod";
import { KNOWN_REPOS, PROD_URLS, type RepoName } from "../config.js";

export const StackHealthGridInput = z.object({
  repos: z
    .array(z.string())
    .optional()
    .describe(
      "Optional subset of repo names to check (e.g. ['codex-pdf', 'lint-pdf']). When omitted, checks every repo with a configured PROD URL.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe(
      "Per-request timeout in ms. The whole grid still resolves; rows that time out get `status: 'timeout'`.",
    ),
});

export interface HealthRow {
  repo: RepoName;
  url: string;
  endpoint: "healthz" | "v1/healthz" | "health" | "ready" | "v1/contract";
  status: number | "timeout" | "error";
  latency_ms: number | null;
  body_summary: string;
}

/** Per-repo endpoint discovery — matches the divergence audit
 *  finding #15 documented. */
function endpointsFor(repo: RepoName): {
  endpoint: HealthRow["endpoint"];
  path: string;
}[] {
  switch (repo) {
    case "codex-pdf":
      return [
        { endpoint: "v1/healthz", path: "/v1/healthz" },
        { endpoint: "v1/contract", path: "/v1/contract" },
      ];
    case "lint-pdf":
      return [
        { endpoint: "health", path: "/health" },
        { endpoint: "ready", path: "/ready" },
      ];
    case "compile-pdf":
      return [
        { endpoint: "v1/healthz", path: "/v1/healthz" },
        { endpoint: "v1/contract", path: "/v1/contract" },
      ];
    case "synergy":
      return [{ endpoint: "healthz", path: "/healthz" }];
    case "platform":
      return [{ endpoint: "healthz", path: "/healthz" }];
    case "lens-pdf":
      return []; // npm library — no HTTP surface
  }
}

async function probe(
  url: string,
  timeout_ms: number,
): Promise<{
  status: number | "timeout" | "error";
  latency_ms: number | null;
  body_summary: string;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout_ms);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const latency_ms = Math.round(performance.now() - t0);
    let body_summary = "";
    try {
      const text = await res.text();
      body_summary = text.slice(0, 200).replace(/\s+/g, " ").trim();
    } catch {
      body_summary = "<unreadable body>";
    }
    return { status: res.status, latency_ms, body_summary };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - t0);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "timeout", latency_ms, body_summary: "" };
    }
    return {
      status: "error",
      latency_ms,
      body_summary: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface StackHealthGridResult {
  rows: HealthRow[];
  notes: string[];
}

export async function stackHealthGrid(
  input: z.infer<typeof StackHealthGridInput>,
): Promise<StackHealthGridResult> {
  const subset = input.repos
    ? (input.repos.filter((r) =>
        KNOWN_REPOS.includes(r as RepoName),
      ) as RepoName[])
    : KNOWN_REPOS;

  const notes: string[] = [];
  const tasks: Promise<HealthRow>[] = [];

  for (const repo of subset) {
    const base = PROD_URLS[repo];
    if (!base) {
      notes.push(
        `repo ${repo}: no PROD URL configured (set SYNERGY_MCP_URL_${repo
          .toUpperCase()
          .replace(/-/g, "_")})`,
      );
      continue;
    }
    for (const ep of endpointsFor(repo)) {
      const url = `${base}${ep.path}`;
      tasks.push(
        probe(url, input.timeout_ms).then((r) => ({
          repo,
          url,
          endpoint: ep.endpoint,
          ...r,
        })),
      );
    }
  }

  const rows = await Promise.all(tasks);
  return { rows, notes };
}
