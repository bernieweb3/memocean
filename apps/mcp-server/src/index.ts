import { Hono } from "hono";
import { MemOceanSDK } from "@memocean/sdk";
import { MemOceanError } from "@memocean/core";
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

  const config: MemOceanConfig = {
    bindings: { DB: env.DB as never, R2: env.R2 as never, KV: env.KV as never },
    llm: {
      allowExternal,
      primaryProvider: "groq",
    },
  };

  if (allowExternal) {
    config.llm.primaryProvider = (env.MEMOCEAN_PRIMARY_PROVIDER || "groq") as MemOceanConfig["llm"]["primaryProvider"];
    config.llm.groq = {
      apiKey: env.GROQ_API_KEY || "",
      model: env.GROQ_MODEL || "llama-3.1-70b-versatile",
    };
    config.llm.openrouter = {
      apiKey: env.OPENROUTER_API_KEY || "",
      model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
    };
    config.llm.nvidia = {
      apiKey: env.NVIDIA_NIM_API_KEY || "",
      model: env.NVIDIA_NIM_MODEL || "meta/llama-3.1-70b-instruct",
    };
  }

  if (env.MEMOCEAN_MASTER_SECRET) {
    config.masterSecret = env.MEMOCEAN_MASTER_SECRET;
    config.projectSalt = env.MEMOCEAN_PROJECT_SALT;
    config.keyVersion = Number.parseInt(env.MEMOCEAN_KEY_VERSION || "1", 10);
  }

  return config;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const publicPaths = new Set(["/health", "/sse"]);
  const isPublic = publicPaths.has(c.req.path);

  if (!isPublic) {
    const secret = getApiSecretKey(c.env as unknown as Env);
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!timingSafeEqualString(auth.slice("Bearer ".length), secret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  await next();

  if (c.res && !c.res.headers.has("Access-Control-Allow-Origin")) {
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  }
});

app.get("/sse", async (c) => {
  const encoder = new TextEncoder();
  const url = new URL(c.req.url);
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${url.origin}/mcp\n\n`));

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepAlive);
          try { controller.close(); } catch {}
        }
      }, 3000);

      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        try { controller.close(); } catch {}
      });

      cleanup = () => clearInterval(keepAlive);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
});

app.get("/health", (c) => c.json({ status: "ok", service: "memocean-mcp-server" }));

app.get("/ready", async (c) => {
  const env = c.env as Env;
  const checks: Record<string, boolean | string> = {};
  try {
    await env.DB.prepare("SELECT 1").run();
    checks.d1 = true;
  } catch (e) {
    checks.d1 = e instanceof Error ? e.message : "unreachable";
  }
  const ok = checks.d1 === true;
  return c.json({ ok, checks }, ok ? 200 : 503);
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
                required: ["content", "projectId"],
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

    const isValidation = error instanceof MemOceanError && error.code === "INVALID_PARAMS";
    const code = isValidation ? -32602 : -32603;
    const status = isValidation ? 400 : 500;
    const message = error instanceof Error ? error.message : "Internal error";
    return c.json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code, message },
    }, status);
  }
});

app.get("/debug/bindings", (c) => {
  if (c.env && typeof c.env === "object" && "ENVIRONMENT" in (c.env as object)) {
    const env = c.env as Record<string, unknown>;
    if (env.ENVIRONMENT === "production") {
      return c.json({ error: "Not available in production" }, 403);
    }
  }
  const env = c.env as Record<string, unknown>;
  return c.json({
    DB: typeof env.DB === "object" && env.DB !== null,
    R2: typeof env.R2 === "object" && env.R2 !== null,
    KV: typeof env.KV === "object" && env.KV !== null,
  });
});

export default app;
