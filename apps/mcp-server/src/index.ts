import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { MemOceanSDK } from "@memocean/sdk";
import type { MemOceanConfig, CloudflareBindings } from "@memocean/core";

const app = new Hono();

function getBindings(): CloudflareBindings {
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          console.log("[D1] exec:", sql, params);
          return { success: true };
        },
        all: async <T = Record<string, unknown>>() => {
          console.log("[D1] query:", sql, params);
          return { results: [] as T[], success: true };
        },
        first: async <T = Record<string, unknown>>() => {
          console.log("[D1] first:", sql, params);
          return null as T | null;
        },
      }),
    }),
    exec: async (sql: string) => {
      console.log("[D1] exec:", sql);
      return { success: true };
    },
    batch: async (_statements: unknown[]) => {
      return { success: true };
    },
    dump: async () => {
      return new Uint8Array();
    },
  };

  return {
    DB: db,
    R2: {
      put: async (_key: string, _value: Uint8Array | ArrayBuffer | string, _options?: Record<string, unknown>) => {
        console.log("[R2] put");
        return {};
      },
      get: async (_key: string) => {
        console.log("[R2] get");
        return null;
      },
      delete: async (_key: string) => {
        console.log("[R2] delete");
      },
    },
    KV: {
      get: async (_key: string) => {
        console.log("[KV] get");
        return null;
      },
      put: async (_key: string, _value: string, _options?: Record<string, unknown>) => {
        console.log("[KV] put");
      },
      delete: async (_key: string) => {
        console.log("[KV] delete");
      },
    },
  };
}

app.use("*", async (c, next) => {
  const apiKey = c.req.header("Authorization");
  const expectedKey = process.env.API_SECRET_KEY;

  if (expectedKey && apiKey !== `Bearer ${expectedKey}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

app.post("/mcp", async (c) => {
  try {
    const body = await c.req.json();

    if (body.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { supported: true },
            resources: { supported: true },
          },
          serverInfo: {
            name: "memocean-mcp-server",
            version: "1.0.0",
          },
        },
      });
    }

    const config: MemOceanConfig = {
      masterSecret: process.env.MASTER_SECRET || "default-master-secret-change-in-production",
      hkdfSalt: process.env.HKDF_SALT || "default-hkdf-salt-change-in-production",
      bindings: getBindings(),
      llm: {
        primaryProvider: "groq",
        groq: {
          apiKey: process.env.GROQ_API_KEY || "",
          model: process.env.GROQ_MODEL || "llama-3.1-70b-versatile",
        },
      },
    };

    const sdk = new MemOceanSDK(config);

    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      let result;

      switch (name) {
        case "ocean_remember":
          await sdk.remember(args);
          result = { content: [{ type: "text", text: "Memory saved successfully" }] };
          break;
        case "ocean_recall": {
          const memories = await sdk.recall(args.query, args.tokenLimit || 1000);
          result = { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
          break;
        }
        case "ocean_context": {
          const memories = await sdk.recall(args.query, args.tokenLimit || 2000);
          result = { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
          break;
        }
        case "ocean_analyze": {
          const analysis = await sdk.analyzeCode(args.code);
          result = { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
          break;
        }
        default:
          return c.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: `Tool not found: ${name}` },
          }, 404);
      }

      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result,
      });
    }

    if (body.method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "ocean_remember",
              description: "Save encrypted memory to MemOcean",
              inputSchema: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  summary: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  sessionId: { type: "string" },
                  projectId: { type: "string" },
                  agentType: { type: "string" },
                },
                required: ["content", "summary", "tags", "sessionId", "projectId", "agentType"],
              },
            },
            {
              name: "ocean_recall",
              description: "Recall memories from MemOcean",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  tokenLimit: { type: "number", default: 1000 },
                },
                required: ["query"],
              },
            },
            {
              name: "ocean_context",
              description: "Recall memories for LLM context injection",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  tokenLimit: { type: "number", default: 2000 },
                },
                required: ["query"],
              },
            },
            {
              name: "ocean_analyze",
              description: "Analyze code using MemOcean's Learn engine",
              inputSchema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          ],
        },
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `Method not found: ${body.method}` },
    }, 404);
  } catch (error) {
    console.error("MCP error:", error);
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(error) },
    }, 500);
  }
});

app.get("/mcp", (c) => {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.body("data: connected\n\n");
});

app.delete("/mcp", (c) => {
  return c.json({ status: "terminated" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);

serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`MemOcean MCP Server running on http://localhost:${info.port}`);
  if (process.argv.includes("--stdio")) {
    console.log("STDIO mode active");
  }
});

export default app;