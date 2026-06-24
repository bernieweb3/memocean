import { CryptoModule } from "@memocean/crypto";
import { R2Adapter, D1Adapter } from "@memocean/storage";
import { SessionManager, CCREngine, TokenBudgeter, LLMProviderManager } from "@memocean/core";
import type { MemOceanConfig, MemoryInput, MemoryMetadata, AnalysisResult } from "@memocean/core";
import { v4 as uuidv4 } from "uuid";

export class MemOceanSDK {
  private crypto: CryptoModule;
  private r2: R2Adapter;
  private d1: D1Adapter;
  private sessions: SessionManager;
  private ccr: CCREngine;
  private budgeter: TokenBudgeter;
  private llm: LLMProviderManager;

  constructor(config: MemOceanConfig) {
    this.crypto = new CryptoModule(config.masterSecret);
    this.r2 = new R2Adapter(config.bindings.R2);
    this.d1 = new D1Adapter(config.bindings.DB);
    this.sessions = new SessionManager((sql: string, ...params: unknown[]) => this.d1.query(sql, ...params));
    this.ccr = new CCREngine();
    this.budgeter = new TokenBudgeter();
    this.llm = new LLMProviderManager(config.llm);
  }

  async remember(input: MemoryInput): Promise<void> {
    const sessionId = await this.sessions.createSession(input.projectId, input.agentType);
    const encrypted = await this.crypto.encrypt(input.content, sessionId);
    const r2Key = uuidv4();

    await this.r2.put(r2Key, encrypted);

    const metadata: MemoryMetadata = {
      id: uuidv4(),
      sessionId,
      projectId: input.projectId,
      r2Key,
      summary: input.summary,
      tags: input.tags,
      relevanceScore: 0.5,
      tokenCount: Math.floor(input.content.length / 4),
      createdAt: new Date().toISOString(),
    };

    await this.d1.insertMetadata(metadata);
  }

  async recall(query: string, tokenLimit: number): Promise<string[]> {
    const metadata = await this.d1.searchFTS(query, 50);

    const scoredMetadata = metadata.map(m => ({
      ...m,
      relevanceScore: this.ccr.calculateRelevanceScore(m, query),
    }));

    const relevant = this.sessions.filterByRelevance(scoredMetadata, tokenLimit);
    const selected = this.budgeter.allocate(relevant, tokenLimit);

    const blobs = await Promise.all(selected.map(m => this.r2.get(m.r2Key)));

    const decrypted = await Promise.all(
      selected.map(async (m, i) => {
        const blob = blobs[i];
        if (!blob) return "";
        return this.crypto.decrypt(blob, m.sessionId);
      })
    );

    return decrypted.filter((d): d is string => d.length > 0);
  }

  async analyzeCode(code: string): Promise<AnalysisResult> {
    return this.llm.analyzeCodeSnippet(code);
  }
}