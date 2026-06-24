import type { AnalysisResult, LLMConfig } from "./types.js";

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface LLMClient {
  analyze(code: string): Promise<AnalysisResult>;
}

export class LLMProviderManager {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async analyzeCodeSnippet(code: string): Promise<AnalysisResult> {
    const providers = this.getProviderOrder();

    for (const provider of providers) {
      try {
        return await provider.client.analyze(code);
      } catch (error) {
        console.error(`Provider ${provider.name} failed:`, error);
      }
    }

    throw new Error("All LLM providers failed");
  }

  private getProviderOrder(): Array<{ name: string; client: LLMClient }> {
    const cfg = this.config;
    const providers: Array<{ name: string; client: LLMClient }> = [];

    if (cfg.groq?.apiKey) {
      const apiKey = cfg.groq.apiKey;
      const model = cfg.groq.model || "llama-3.1-70b-versatile";
      providers.push({
        name: "groq",
        client: {
          async analyze(code: string): Promise<AnalysisResult> {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an AI coding assistant that analyzes code and extracts lessons, patterns, and summaries. Return a JSON object with 'lessons', 'patterns', and 'summary' fields.",
                  },
                  {
                    role: "user",
                    content: `Analyze this code and provide lessons, patterns, and a summary:\n\n${code}`,
                  },
                ],
              }),
            });

            const data = await response.json() as { choices: Array<{ message: { content: string } }> };
            const content = data.choices[0].message.content;

            try {
              return JSON.parse(content);
            } catch {
              return { lessons: [], patterns: [], summary: content };
            }
          },
        },
      });
    }

    if (cfg.ollama?.model) {
      const model = cfg.ollama.model;
      const endpoint = cfg.ollama.endpoint || "https://ollama.com/v1/";
      providers.push({
        name: "ollama",
        client: {
          async analyze(code: string): Promise<AnalysisResult> {
            const response = await fetch(`${endpoint}chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an AI coding assistant that analyzes code and extracts lessons, patterns, and summaries. Return a JSON object with 'lessons', 'patterns', and 'summary' fields.",
                  },
                  {
                    role: "user",
                    content: `Analyze this code and provide lessons, patterns, and a summary:\n\n${code}`,
                  },
                ],
              }),
            });

            const data = await response.json() as { choices: Array<{ message: { content: string } }> };
            const content = data.choices[0].message.content;

            try {
              return JSON.parse(content);
            } catch {
              return { lessons: [], patterns: [], summary: content };
            }
          },
        },
      });
    }

    if (cfg.openrouter?.apiKey) {
      const apiKey = cfg.openrouter.apiKey;
      const model = cfg.openrouter.model;
      providers.push({
        name: "openrouter",
        client: {
          async analyze(code: string): Promise<AnalysisResult> {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an AI coding assistant that analyzes code and extracts lessons, patterns, and summaries. Return a JSON object with 'lessons', 'patterns', and 'summary' fields.",
                  },
                  {
                    role: "user",
                    content: `Analyze this code and provide lessons, patterns, and a summary:\n\n${code}`,
                  },
                ],
              }),
            });

            const data = await response.json() as { choices: Array<{ message: { content: string } }> };
            const content = data.choices[0].message.content;

            try {
              return JSON.parse(content);
            } catch {
              return { lessons: [], patterns: [], summary: content };
            }
          },
        },
      });
    }

    if (cfg.nvidia?.apiKey) {
      const apiKey = cfg.nvidia.apiKey;
      const model = cfg.nvidia.model;
      providers.push({
        name: "nvidia",
        client: {
          async analyze(code: string): Promise<AnalysisResult> {
            const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an AI coding assistant that analyzes code and extracts lessons, patterns, and summaries. Return a JSON object with 'lessons', 'patterns', and 'summary' fields.",
                  },
                  {
                    role: "user",
                    content: `Analyze this code and provide lessons, patterns, and a summary:\n\n${code}`,
                  },
                ],
              }),
            });

            const data = await response.json() as { choices: Array<{ message: { content: string } }> };
            const content = data.choices[0].message.content;

            try {
              return JSON.parse(content);
            } catch {
              return { lessons: [], patterns: [], summary: content };
            }
          },
        },
      });
    }

    return providers;
  }
}