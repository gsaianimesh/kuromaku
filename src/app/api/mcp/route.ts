import { NextResponse, type NextRequest } from "next/server";
import {
  apiCoverageGaps,
  apiGetMemory,
  apiListArtifacts,
  apiRecordObservation,
  apiRunAgent,
  apiSearchMemory,
} from "@/lib/api";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * MCP server over Streamable HTTP (SPEC 7.11).
 *
 * JSON-RPC 2.0 on a single POST endpoint. Implemented directly rather than
 * through an SDK: the surface is initialize, tools/list and tools/call, and the
 * tool bodies are the same functions the REST API calls, so the two cannot
 * drift apart.
 */

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const TOOLS = [
  {
    name: "get_memory",
    description:
      "Read the workspace's active marketing memory. Every record carries its sources and an `unsourced` flag; a record with no sources is an unverified inference, not a fact.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Filter by record type: product_fact, icp_segment, positioning, messaging_pillar, objection, competitor, channel_priority, roadmap_item, voice_rule.",
        },
        locale: { type: "string", description: "Filter by locale, e.g. 'en' or 'ja'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_memory",
    description:
      "Full-text search across memory record keys and values. Returns the same sourced records as get_memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        limit: { type: "number", description: "Max records to return. Default 20." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_artifacts",
    description:
      "List drafts and published work with their evidence. Evidence items marked `superseded` mean the memory that artifact was derived from has since changed.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "draft, approved, rejected, published, or stale.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_agent",
    description:
      "Queue a channel agent run. This never publishes anything — the draft lands in the review queue for a human. Returns a job id.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent id, e.g. 'launch_community' or 'content'.",
        },
        channel: { type: "string", description: "Channel the agent should target." },
        locale: { type: "string", description: "Locale to draft in. Default 'en'." },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "record_observation",
    description:
      "Record a measured performance figure against a published artifact. Only record what was actually observed — this system never displays a metric it did not measure.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact's uuid." },
        metric: {
          type: "string",
          description: "e.g. impressions, clicks, upvotes, comments, signups.",
        },
        value: { type: "number", description: "The observed value." },
      },
      required: ["artifactId", "metric", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "list_coverage_gaps",
    description:
      "List prioritised channels that have no registered agent. A gap means the strategy asked for a channel nothing can execute.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function fail(id: JsonRpcRequest["id"], code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
}

/** MCP tool results are content blocks; JSON goes in a text block. */
function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const ws = await getOrCreateDefaultWorkspace();

  switch (name) {
    case "get_memory": {
      const records = await apiGetMemory(ws.id, {
        type: typeof args.type === "string" ? args.type : undefined,
        locale: typeof args.locale === "string" ? args.locale : undefined,
      });
      return textResult({
        count: records.length,
        unsourced: records.filter((r) => r.unsourced).length,
        records,
      });
    }
    case "search_memory": {
      if (typeof args.query !== "string") {
        return textResult({ error: "query is required" }, true);
      }
      const records = await apiSearchMemory(
        ws.id,
        args.query,
        typeof args.limit === "number" ? args.limit : 20,
      );
      return textResult({ count: records.length, records });
    }
    case "list_artifacts": {
      const artifacts = await apiListArtifacts(
        ws.id,
        typeof args.status === "string" ? args.status : undefined,
      );
      return textResult({ count: artifacts.length, artifacts });
    }
    case "run_agent": {
      if (typeof args.agentId !== "string") {
        return textResult({ error: "agentId is required" }, true);
      }
      try {
        const result = await apiRunAgent(ws.id, {
          agentId: args.agentId,
          channel: typeof args.channel === "string" ? args.channel : undefined,
          locale: typeof args.locale === "string" ? args.locale : undefined,
        });
        return textResult({
          ...result,
          note: "Queued. Nothing is published — the draft goes to the review queue.",
        });
      } catch (e) {
        return textResult(
          { error: e instanceof Error ? e.message : "Failed" },
          true,
        );
      }
    }
    case "record_observation": {
      if (
        typeof args.artifactId !== "string" ||
        typeof args.metric !== "string" ||
        typeof args.value !== "number"
      ) {
        return textResult(
          { error: "artifactId, metric and value are required" },
          true,
        );
      }
      try {
        await apiRecordObservation(ws.id, {
          artifactId: args.artifactId,
          metric: args.metric,
          value: args.value,
        });
        return textResult({ ok: true });
      } catch (e) {
        return textResult(
          { error: e instanceof Error ? e.message : "Failed" },
          true,
        );
      }
    }
    case "list_coverage_gaps": {
      return textResult({ gaps: await apiCoverageGaps(ws.id) });
    }
    default:
      return textResult({ error: `Unknown tool: ${name}` }, true);
  }
}

export async function POST(req: NextRequest) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return fail(null, -32700, "Parse error");
  }

  // Batches are legal JSON-RPC; handle the single-request case the same way.
  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const request of requests) {
    const { id, method, params } = request;

    switch (method) {
      case "initialize":
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "kuromaku", version: "0.1.0" },
          },
        });
        break;

      case "notifications/initialized":
        // A notification has no id and takes no response.
        break;

      case "ping":
        responses.push({ jsonrpc: "2.0", id, result: {} });
        break;

      case "tools/list":
        responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;

      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") {
          responses.push({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "params.name is required" },
          });
          break;
        }
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        try {
          responses.push({
            jsonrpc: "2.0",
            id,
            result: await callTool(name, args),
          });
        } catch (e) {
          responses.push({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: e instanceof Error ? e.message : "Internal error",
            },
          });
        }
        break;
      }

      default:
        responses.push({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }

  if (responses.length === 0) return new NextResponse(null, { status: 202 });

  return NextResponse.json(Array.isArray(body) ? responses : responses[0], {
    headers: { "cache-control": "no-store" },
  });
}

/** A GET returns the tool manifest, which makes the endpoint discoverable. */
export async function GET() {
  return NextResponse.json({
    server: { name: "kuromaku", version: "0.1.0" },
    protocolVersion: PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: "/api/mcp",
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  });
}
