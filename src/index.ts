#!/usr/bin/env node
/**
 * synergy-mcp — cross-stack dev-audit MCP server for the Print With
 * Synergy stack. Serves four tools over stdio:
 *
 *  - blast_radius — find every call site of a symbol / route / env
 *    var across the six configured repos.
 *  - floor_pin_grid — the (repo × org-package × version-spec) matrix.
 *  - pattern_audit — the (repo × architectural-pattern) matrix.
 *  - stack_health_grid — parallel /healthz + /v1/contract probes
 *    across the prod URLs.
 *
 * Configuration is via environment variables — see ./config.ts.
 * Designed to run from Claude Code via `npx @printwithsynergy/synergy-mcp`
 * (or installed globally) over the stdio transport.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasAnyRepo } from "./config.js";
import { BlastRadiusInput, blastRadius } from "./tools/blast-radius.js";
import { FloorPinGridInput, floorPinGrid } from "./tools/floor-pin-grid.js";
import { PatternAuditInput, patternAudit } from "./tools/pattern-audit.js";
import {
  StackHealthGridInput,
  stackHealthGrid,
} from "./tools/stack-health-grid.js";

const SERVER_NAME = "synergy-mcp";
const SERVER_VERSION = "0.1.0";

/**
 * Convert a Zod schema into a JSON Schema for the MCP `inputSchema`.
 * The MCP SDK doesn't ship a Zod-to-JSON-Schema converter; we emit
 * the minimum the spec requires for each tool. We use Zod's
 * `.describe()` on each field so the schema carries human-readable
 * descriptions.
 */
type ToolDef<Input extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  description: string;
  schema: Input;
  handler: (parsed: z.infer<Input>) => Promise<unknown>;
};

const TOOLS = [
  {
    name: "blast_radius",
    description:
      "Find every call site of a symbol, HTTP route, or env var across the printwithsynergy stack's six repos (codex-pdf, lint-pdf, lens-pdf, compile-pdf, synergy, platform). Use to answer 'who breaks if I change X?' before refactoring across the seam.",
    schema: BlastRadiusInput,
    handler: blastRadius,
  } satisfies ToolDef<typeof BlastRadiusInput>,
  {
    name: "floor_pin_grid",
    description:
      "Return the (repo × org-package × version-spec) matrix across pyproject.toml dependencies + package.json {dependencies,devDependencies,peerDependencies}. Detects drift — e.g. one repo pinning codex-pdf>=1.19.0 with no upper bound while another caps at <2.0.",
    schema: FloorPinGridInput,
    handler: floorPinGrid,
  } satisfies ToolDef<typeof FloorPinGridInput>,
  {
    name: "pattern_audit",
    description:
      "Return the (repo × pattern) matrix for the architectural patterns the cross-stack audit found inconsistently applied. Patterns include presence of CI workflows, the /v1/contract endpoint, consume-surface-audit / engine-purity tripwires, RFC 7807 Problem Details, and CLAUDE.md depth.",
    schema: PatternAuditInput,
    handler: patternAudit,
  } satisfies ToolDef<typeof PatternAuditInput>,
  {
    name: "stack_health_grid",
    description:
      "Fetch /healthz and /v1/contract (where exposed) across the configured prod URLs for the stack, in parallel, returning status code + latency + body summary per probe. Branches per-repo for the five different endpoint shapes the audit cataloged.",
    schema: StackHealthGridInput,
    handler: stackHealthGrid,
  } satisfies ToolDef<typeof StackHealthGridInput>,
] as const;

/** Render a Zod object schema to a minimal JSON Schema. */
function toJsonSchema(
  zod: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const shape = zod.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(shape)) {
    const field = raw as z.ZodTypeAny;
    const description = field.description ?? undefined;
    const entry: Record<string, unknown> = { description };
    let inner: z.ZodTypeAny = field;
    if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
      inner = field._def.innerType as z.ZodTypeAny;
    } else {
      required.push(key);
    }
    if (inner instanceof z.ZodString) {
      entry.type = "string";
    } else if (inner instanceof z.ZodNumber) {
      entry.type = "number";
    } else if (inner instanceof z.ZodBoolean) {
      entry.type = "boolean";
    } else if (inner instanceof z.ZodEnum) {
      entry.type = "string";
      entry.enum = inner._def.values;
    } else if (inner instanceof z.ZodArray) {
      entry.type = "array";
      entry.items = { type: "string" };
    } else {
      entry.type = "object";
    }
    properties[key] = entry;
  }
  const out: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required.length > 0) out.required = required;
  return out;
}

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.schema),
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    if (!hasAnyRepo() && name !== "stack_health_grid") {
      return {
        content: [
          {
            type: "text" as const,
            text: "No repos configured. Set SYNERGY_MCP_STACK_ROOT to the directory containing your six repo clones, or SYNERGY_MCP_PATH_<REPO> per-repo (e.g. SYNERGY_MCP_PATH_CODEX_PDF=/path/to/codex-pdf).",
          },
        ],
        isError: true,
      };
    }

    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid arguments for ${name}: ${parsed.error.message}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(parsed.data as never);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Tool error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Lifecycle: server runs until stdio closes.
}

main().catch((err) => {
  console.error("synergy-mcp fatal:", err);
  process.exit(1);
});
