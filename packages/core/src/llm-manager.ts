import type { AnalysisResult, LLMConfig } from "./types.js";

interface LLMClient {
  analyze(code: string): Promise<AnalysisResult>;
}

const MAX_CODE_CHARS = 200 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, ms = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseOpenAIContent(data: unknown): string {
  if (
    typeof data === "object" && data !== null &&
    Array.isArray((data as { choices?: unknown[] }).choices) &&
    typeof (data as any).choices[0]?.message?.content === "string"
  ) {
    const content = (data as any).choices[0].message.content;
    if (content.length > 200_000) throw new Error("Provider response too large");
    return content;
  }
  throw new Error("Invalid provider response");
}

function normalizeAnalysisResult(value: unknown, fallbackSummary: string): AnalysisResult {
  if (typeof value === "object" && value !== null) {
    const obj = value as Partial<AnalysisResult>;
    return {
      lessons: Array.isArray(obj.lessons) ? obj.lessons.filter((v): v is string => typeof v === "string") : [],
      patterns: Array.isArray(obj.patterns) ? obj.patterns.filter((v): v is string => typeof v === "string") : [],
      summary: typeof obj.summary === "string" ? obj.summary : fallbackSummary,
    };
  }
  return { lessons: [], patterns: [], summary: fallbackSummary };
}

function parseAnalysisContent(content: string): AnalysisResult {
  try {
    return normalizeAnalysisResult(JSON.parse(content), content);
  } catch {
    return { lessons: [], patterns: [], summary: content };
  }
}

function validateCode(code: string): void {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_CHARS) {
    throw new Error("Invalid code length");
  }
}

async function callOpenAICompatible(
  url: string,
  headers: Record<string, string>,
  model: string,
  code: string
): Promise<AnalysisResult> {
  validateCode(code);

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Analyze code and return strict JSON with string[] lessons, string[] patterns, and string summary.",
        },
        {
          role: "user",
          content: `Analyze this code and provide lessons, patterns, and a summary:\n\n${code}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) throw new Error("Provider request failed");
  const data = await response.json();
  return parseAnalysisContent(parseOpenAIContent(data));
}

export class LLMProviderManager {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async analyzeCodeSnippet(code: string): Promise<AnalysisResult> {
    validateCode(code);
    const providers = this.getProviderOrder();

    if (providers.length === 0) {
      throw new Error("No LLM providers configured");
    }

    for (const provider of providers) {
      try {
        return await provider.client.analyze(code);
      } catch (error) {
        console.error("Provider failed", {
          provider: provider.name,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    throw new Error("All LLM providers failed");
  }

  private getProviderOrder(): Array<{ name: string; client: LLMClient }> {
    const cfg = this.config;
    const providers: Array<{ name: string; client: LLMClient }> = [];

    if (cfg.allowExternal === false && cfg.ollama?.model) {
      const model = cfg.ollama.model;
      const endpoint = cfg.ollama.endpoint || "http://localhost:11434/v1/";
      providers.push({
        name: "ollama",
        client: {
          analyze: (code: string) => callOpenAICompatible(
            `${endpoint.replace(/\/$/, "")}/chat/completions`,
            cfg.ollama?.apiKey ? { Authorization: `Bearer ${cfg.ollama.apiKey}` } : {},
            model,
            code
          ),
        },
      });
      return providers;
    }

    if (cfg.groq?.apiKey) {
      const apiKey = cfg.groq.apiKey;
      const model = cfg.groq.model || "llama-3.1-70b-versatile";
      providers.push({
        name: "groq",
        client: {
          analyze: (code: string) => callOpenAICompatible(
            "https://api.groq.com/openai/v1/chat/completions",
            { Authorization: `Bearer ${apiKey}` },
            model,
            code
          ),
        },
      });
    }

    if (cfg.ollama?.model) {
      const model = cfg.ollama.model;
      const endpoint = cfg.ollama.endpoint || "http://localhost:11434/v1/";
      providers.push({
        name: "ollama",
        client: {
          analyze: (code: string) => callOpenAICompatible(
            `${endpoint.replace(/\/$/, "")}/chat/completions`,
            cfg.ollama?.apiKey ? { Authorization: `Bearer ${cfg.ollama.apiKey}` } : {},
            model,
            code
          ),
        },
      });
    }

    if (cfg.openrouter?.apiKey) {
      const apiKey = cfg.openrouter.apiKey;
      const model = cfg.openrouter.model;
      providers.push({
        name: "openrouter",
        client: {
          analyze: (code: string) => callOpenAICompatible(
            "https://openrouter.ai/api/v1/chat/completions",
            { Authorization: `Bearer ${apiKey}` },
            model,
            code
          ),
        },
      });
    }

    if (cfg.nvidia?.apiKey) {
      const apiKey = cfg.nvidia.apiKey;
      const model = cfg.nvidia.model;
      providers.push({
        name: "nvidia",
        client: {
          analyze: (code: string) => callOpenAICompatible(
            "https://integrate.api.nvidia.com/v1/chat/completions",
            { Authorization: `Bearer ${apiKey}` },
            model,
            code
          ),
        },
      });
    }

    const preferredIndex = providers.findIndex(provider => provider.name === cfg.primaryProvider);
    if (preferredIndex > 0) {
      const [preferred] = providers.splice(preferredIndex, 1);
      providers.unshift(preferred);
    }

    return providers;
  }
}

export { fetchWithTimeout, parseOpenAIContent };
