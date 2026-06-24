export interface CloudflareBindings {
  DB: {
    prepare: (sql: string) => {
      bind: (...params: unknown[]) => {
        run: () => Promise<{ success: boolean; meta?: Record<string, unknown> }>;
        all: <T = Record<string, unknown>>() => Promise<{ results: T[]; success: boolean }>;
        first: <T = Record<string, unknown>>() => Promise<T | null>;
      };
    };
    exec: (sql: string) => Promise<{ success: boolean }>;
    batch: (statements: unknown[]) => Promise<{ success: boolean }>;
    dump: () => Promise<Uint8Array>;
  };
  R2: {
    put: (key: string, value: Uint8Array | ArrayBuffer | string, options?: Record<string, unknown>) => Promise<unknown>;
    get: (key: string) => Promise<{
      body?: ReadableStream;
      arrayBuffer?: () => Promise<ArrayBuffer>;
      write?: (dest: unknown) => Promise<void>;
    } | null>;
    delete: (key: string) => Promise<void>;
  };
  KV: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: Record<string, unknown>) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
}

export interface LLMConfig {
  primaryProvider: "groq" | "ollama" | "openrouter" | "nvidia";
  groq?: {
    apiKey: string;
    model: string;
  };
  ollama?: {
    apiKey?: string;
    model: string;
    endpoint: string;
  };
  openrouter?: {
    apiKey: string;
    model: string;
  };
  nvidia?: {
    apiKey: string;
    model: string;
  };
}

export interface MemOceanConfig {
  masterSecret: string;
  hkdfSalt: string;
  bindings: CloudflareBindings;
  llm: LLMConfig;
}

export interface MemoryInput {
  content: string;
  summary: string;
  tags: string[];
  sessionId: string;
  projectId: string;
  agentType: string;
}

export interface MemoryMetadata {
  id: string;
  sessionId: string;
  projectId: string;
  r2Key: string;
  summary: string;
  tags: string[];
  relevanceScore: number;
  tokenCount: number;
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  parentSessionId?: string;
  agentType: string;
  createdAt: string;
}

export interface AnalysisResult {
  lessons: string[];
  patterns: string[];
  summary: string;
}

export class MemOceanError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MemOceanError";
  }
}