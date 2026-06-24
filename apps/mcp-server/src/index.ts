import { Hono } from "hono";
import { MemOceanSDK } from "@memocean/sdk";
import type { MemOceanConfig, CloudflareBindings } from "@memocean/core";
import { validateAnalyzeArgs, validateRecallArgs, validateRememberArgs } from "./tools.js";

function getApiSecretKey(env: Record<string, string | undefined>): string {
  const key = env.API_SECRET_KEY;
  if (!key || key.length < 32) {
    throw new Error("API_SECRET_KEY must be set and >= 32 chars");
  }
  return key;
}

const MAX_BODY_BYTES = 1024 * 1024;
const app = new Hono();

type JsonRpcBody = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: unknown;
  };
};

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function parseJsonBody(c: { req: { header: (name: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer> } }): Promise<JsonRpcBody> {
  const contentLength = c.req.header("Content-Length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    throw new Error("Request body too large");
  }

  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) throw new Error("Request body too large");
  if (raw.byteLength === 0) throw new Error("Empty request body");

  const parsed = JSON.parse(new TextDecoder().decode(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid JSON-RPC body");
  return parsed as JsonRpcBody;
}

function getBindings(): CloudflareBindings {
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          console.log("[D1] exec:", sql, params.length);
          return { success: true };
        },
        all: async <T = Record<string, unknown>>() => {
          console.log("[D1] query:", sql, params.length);
          return { results: [] as T[], success: true };
        },
        first: async <T = Record<string, unknown>>() => {
          console.log("[D1] first:", sql, params.length);
          return null as T | null;
        },
      }),
    }),
    exec: async (sql: string) => {
      console.log("[D1] exec:", sql);
      return { success: true };
    },
    batch: async (_statements: unknown[]) => ({ success: true }),
    dump: async () => new Uint8Array(),
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

function getConfig(env: Record<string, string | undefined>): MemOceanConfig {
  const allowExternal = env.MEMOCEAN_ALLOW_EXTERNAL_LLM === "true";
  const primaryProvider = (env.MEMOCEAN_PRIMARY_PROVIDER || "groq") as MemOceanConfig["llm"]["primaryProvider"];

  const config: MemOceanConfig = {
    bindings: getBindings(),
    llm: {
      allowExternal,
      primaryProvider,
      groq: {
        apiKey: env.GROQ_API_KEY || "",
        model: env.GROQ_MODEL || "llama-3.1-70b-versatile",
      },
      openrouter: {
        apiKey: env.OPENROUTER_API_KEY || "",
        model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      },
      nvidia: {
        apiKey: env.NVIDIA_NIM_API_KEY || "",
        model: env.NVIDIA_NIM_MODEL || "meta/llama-3.1-70b-instruct",
      },
    },
  };

  if (env.MEMOCEAN_MASTER_SECRET) {
    config.masterSecret = env.MEMOCEAN_MASTER_SECRET;
    config.projectSalt = env.MEMOCEAN_PROJECT_SALT;
    config.keyVersion = Number.parseInt(env.MEMOCEAN_KEY_VERSION || "1", 10);
  }

  return config;
}

app.use("*", async (c, next) => {
  if (c.req.path === "/health" && c.req.method === "GET") {
    return c.json({ status: "ok", service: "memocean-mcp-server" });
  }

  const secret = getApiSecretKey(c.env as Record<string, string | undefined>);

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice("Bearer ".length);
  if (!timingSafeEqualString(token, secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

app.post("/mcp", async (c) => {
  let body: JsonRpcBody | undefined;

  try {
    body = await parseJsonBody(c);

    if (body.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
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

    if (body.method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          tools: [
            {
              name: "ocean_remember",
              description: "Save encrypted memory to MemOcean",
              inputSchema: {
                type: "object",
                properties: {
                  content: { type: "string", maxLength: 65536 },
                  summary: { type: "string", maxLength: 2048 },
                  tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
                  projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,128}$" },
                  agentType: { type: "string", maxLength: 64 },
                },
                required: ["content", "summary", "tags", "projectId", "agentType"],
              },
            },
            {
              name: "ocean_recall",
              description: "Recall memories from MemOcean",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", maxLength: 256 },
                  projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,128}$" },
                  tokenLimit: { type: "number", minimum: 1, maximum: 8000, default: 1000 },
                },
                required: ["query", "projectId"],
              },
            },
            {
              name: "ocean_context",
              description: "Recall memories for LLM context injection",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", maxLength: 256 },
                  projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,128}$" },
                  tokenLimit: { type: "number", minimum: 1, maximum: 8000, default: 2000 },
                },
                required: ["query", "projectId"],
              },
            },
            {
              name: "ocean_analyze",
              description: "Analyze code and extract lessons",
              inputSchema: {
                type: "object",
                properties: {
                  code: { type: "string", maxLength: 204800 },
                },
                required: ["code"],
              },
            },
          ],
        },
      });
    }

    if (body.method !== "tools/call") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32601, message: "Method not found" },
      }, 404);
    }

    const toolName = body.params?.name;
    const args = body.params?.arguments;
    const sdk = new MemOceanSDK(getConfig(c.env as Record<string, string | undefined>));
    let result: { content: Array<{ type: "text"; text: string }> };

    switch (toolName) {
      case "ocean_remember":
        await sdk.remember(validateRememberArgs(args));
        result = { content: [{ type: "text", text: "Memory saved successfully" }] };
        break;
      case "ocean_recall": {
        const { query, tokenLimit, projectId } = validateRecallArgs(args, 1000);
        const memories = await sdk.recall(query, tokenLimit, projectId);
        result = { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
        break;
      }
      case "ocean_context": {
        const { query, tokenLimit, projectId } = validateRecallArgs(args, 2000);
        const memories = await sdk.recall(query, tokenLimit, projectId);
        result = { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
        break;
      }
      case "ocean_analyze": {
        const { code } = validateAnalyzeArgs(args);
        const analysis = await sdk.analyzeCode(code);
        result = { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
        break;
      }
      default:
        return c.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32601, message: "Tool not found" },
        }, 404);
    }

    return c.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result,
    });
  } catch (error) {
    console.error("MCP error", {
      message: error instanceof Error ? error.message : "unknown",
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: -32603, message: "Internal error" },
    }, 500);
  }
});

export default app;
