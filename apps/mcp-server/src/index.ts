import { Hono } from "hono";
import { MemOceanSDK } from "@memocean/sdk";
import type { MemOceanConfig } from "@memocean/core";
import { validateAnalyzeArgs, validateRecallArgs, validateRememberArgs } from "./tools.js";

function getApiSecretKey(env: Env): string {
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

type Env = {
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  API_SECRET_KEY: string;
  MEMOCEAN_MASTER_SECRET?: string;
  MEMOCEAN_PROJECT_SALT?: string;
  MEMOCEAN_KEY_VERSION?: string;
  MEMOCEAN_ALLOW_EXTERNAL_LLM?: string;
  MEMOCEAN_PRIMARY_PROVIDER?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  NVIDIA_NIM_API_KEY?: string;
  NVIDIA_NIM_MODEL?: string;
};

function getConfig(env: Env): MemOceanConfig {
  const allowExternal = env.MEMOCEAN_ALLOW_EXTERNAL_LLM === "true";
  const primaryProvider = (env.MEMOCEAN_PRIMARY_PROVIDER || "groq") as MemOceanConfig["llm"]["primaryProvider"];

  const config: MemOceanConfig = {
    bindings: { DB: env.DB as never, R2: env.R2 as never, KV: env.KV as never },
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

  if (c.req.path === "/sse" && c.req.method === "GET") {
    return await next();
  }

  if (c.req.path.startsWith("/debug/")) {
    return await next();
  }

  const secret = getApiSecretKey(c.env as unknown as Env);

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

app.get("/sse", async (c) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const url = new URL(c.req.url);

  try {
    writer.write(encoder.encode(`event: endpoint\ndata: ${url.origin}/mcp\n\n`));

    const keepAlive = setInterval(() => {
      writer.write(encoder.encode(`: keepalive\n\n`)).catch(() => clearInterval(keepAlive));
    }, 15000);

    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      writer.close().catch(() => {});
    });
  } catch {
    writer.close().catch(() => {});
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

app.get("/mcp", (c) => {
  return c.json({
    jsonrpc: "2.0",
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
});

app.delete("/mcp", (c) => {
  return c.json({ status: "terminated" });
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
    const sdk = new MemOceanSDK(getConfig(c.env as unknown as Env));
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

    const stack = error instanceof Error ? error.stack : undefined;
    console.error("MCP error stack", stack);
    const message = error instanceof Error ? error.message : "Internal error";
    return c.json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: -32603, message },
    }, 500);
  }
});

app.get("/debug/bindings", (c) => {
  const env = c.env as Record<string, unknown>;
  return c.json({
    DB: typeof env.DB === "object" && env.DB !== null,
    R2: typeof env.R2 === "object" && env.R2 !== null,
    KV: typeof env.KV === "object" && env.KV !== null,
    hasMasterSecret: typeof env.MEMOCEAN_MASTER_SECRET === "string",
    hasProjectSalt: typeof env.MEMOCEAN_PROJECT_SALT === "string",
  });
});

export default app;
