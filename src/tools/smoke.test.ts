/**
 * Smoke test — runs each tool against a real working-tree layout.
 *
 * Skipped automatically if SYNERGY_MCP_STACK_ROOT isn't set. This is
 * a confidence test that exercises the file-walking + parsing paths
 * end-to-end; the network probe in stack_health_grid is mocked.
 */
import { describe, expect, it } from "vitest";
import { blastRadius } from "./blast-radius.js";
import { floorPinGrid } from "./floor-pin-grid.js";
import { patternAudit } from "./pattern-audit.js";
import { stackHealthGrid } from "./stack-health-grid.js";

const HAS_STACK = !!process.env.SYNERGY_MCP_STACK_ROOT;

describe.skipIf(!HAS_STACK)("smoke — against SYNERGY_MCP_STACK_ROOT", () => {
  it("floor_pin_grid returns rows for codex-pdf", async () => {
    const result = await floorPinGrid({ package: "codex-pdf" });
    // At least one of lint-pdf, compile-pdf should pin codex-pdf
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.package).toBe("codex-pdf");
    }
  });

  it("pattern_audit emits has_ci rows for every configured repo", async () => {
    const result = await patternAudit({ patterns: ["has_ci"] });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.pattern).toBe("has_ci");
      expect(typeof row.present).toBe("boolean");
    }
  });

  it("blast_radius for an env var finds at least one match", async () => {
    const result = await blastRadius({
      target: "DATABASE_URL",
      kind: "env_var",
      max_results_per_repo: 5,
    });
    // synergy + platform both reference DATABASE_URL somewhere
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("blast_radius for a route finds quoted occurrences", async () => {
    const result = await blastRadius({
      target: "/v1/contract",
      kind: "route",
      max_results_per_repo: 5,
    });
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe("stack_health_grid (no network)", () => {
  it("returns empty rows when no PROD URLs are configured", async () => {
    // With every URL env unset and lens-pdf having no PROD URL by
    // design, restricting to lens-pdf gives us a stable empty grid.
    const result = await stackHealthGrid({
      repos: ["lens-pdf"],
      timeout_ms: 1000,
    });
    expect(result.rows).toEqual([]);
  });
});
