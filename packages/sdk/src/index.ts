import { CryptoModule, type EncryptedEnvelope } from "@memocean/crypto";
import { R2Adapter, D1Adapter } from "@memocean/storage";
import { SessionManager, CCREngine, TokenBudgeter, LLMProviderManager } from "@memocean/core";
import type { MemOceanConfig, MemoryInput, MemoryMetadata, AnalysisResult } from "@memocean/core";

const DEFAULT_KEY_VERSION = 1;
const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} invalid format`);
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "_");
}

function parseProjectSalt(value: string | Uint8Array | undefined): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw new Error("projectSalt must be 32 bytes");
    return new Uint8Array(value);
  }

  if (typeof value === "string") {
    const hex = value.trim();
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error("projectSalt must be 32-byte hex");
    const out = new Uint8Array(32);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  throw new Error("projectSalt is required");
}

function encodeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function decodeEnvelope(data: Uint8Array): EncryptedEnvelope {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as EncryptedEnvelope;
  } catch {
    throw new Error("Invalid encrypted envelope");
  }
}

export class MemOceanSDK {
  private crypto?: CryptoModule;
  private r2: R2Adapter;
  private d1: D1Adapter;
  private sessions: SessionManager;
  private ccr: CCREngine;
  private budgeter: TokenBudgeter;
  private llm: LLMProviderManager;
  private projectSalt?: Uint8Array;
  private keyVersion: number;

  constructor(config: MemOceanConfig) {
    if (config.masterSecret) {
      this.crypto = new CryptoModule(config.masterSecret);
      this.projectSalt = parseProjectSalt(config.projectSalt);
    }

    this.keyVersion = config.keyVersion ?? DEFAULT_KEY_VERSION;
    this.r2 = new R2Adapter(config.bindings.R2);
    this.d1 = new D1Adapter(config.bindings.DB);
    this.sessions = new SessionManager(
      session => this.d1.insertSession(session),
      (projectId, sessionId) => this.d1.getSession(projectId, sessionId)
    );
    this.ccr = new CCREngine();
    this.budgeter = new TokenBudgeter();
    this.llm = new LLMProviderManager(config.llm);
  }

  async remember(input: MemoryInput): Promise<void> {
    if (!this.crypto || !this.projectSalt) {
      throw new Error("Server-side crypto is not configured; send only through a zero-knowledge client flow");
    }

    assertId(input.projectId, "projectId");
    const sessionId = await this.sessions.createSession(input.projectId, input.agentType);
    const memoryId = randomId();

    const envelope = await this.crypto.encrypt(input.content, {
      projectId: input.projectId,
      sessionId,
      memoryId,
      keyVersion: this.keyVersion,
      projectSalt: this.projectSalt,
    });

    await this.r2.put(input.projectId, memoryId, encodeEnvelope(envelope), {
      alg: envelope.alg,
      keyVersion: String(envelope.keyVersion),
      createdAt: new Date().toISOString(),
    });

    const metadata: MemoryMetadata = {
      id: memoryId,
      sessionId,
      projectId: input.projectId,
      r2Key: memoryId,
      summary: input.summary,
      tags: input.tags,
      relevanceScore: 0.5,
      tokenCount: Math.max(1, Math.ceil(input.content.length / 4)),
      createdAt: new Date().toISOString(),
    };

    await this.d1.insertMetadata(metadata);
  }

  async recall(query: string, tokenLimit: number, projectId?: string): Promise<string[]> {
    if (!this.crypto || !this.projectSalt) {
      throw new Error("Server-side crypto is not configured; use zero-knowledge client-side decrypt");
    }
    if (!projectId) throw new Error("projectId is required");
    assertId(projectId, "projectId");

    const metadata = await this.d1.searchFTS(projectId, query, 50);

    const scoredMetadata = metadata.map(m => ({
      ...m,
      relevanceScore: this.ccr.calculateRelevanceScore(m, query),
    }));

    const selected = this.budgeter.allocate(scoredMetadata, tokenLimit);
    const blobs = await Promise.all(selected.map(m => this.r2.get(projectId, m.id)));

    const decrypted = await Promise.all(
      selected.map(async (_m, i) => {
        const blob = blobs[i];
        if (!blob) return "";
        const envelope = decodeEnvelope(blob);
        if (envelope.projectId !== projectId) throw new Error("Envelope project mismatch");
        return this.crypto!.decrypt(envelope, this.projectSalt!);
      })
    );

    return decrypted.filter((d): d is string => d.length > 0);
  }

  async analyzeCode(code: string): Promise<AnalysisResult> {
    return this.llm.analyzeCodeSnippet(code);
  }
}
