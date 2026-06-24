import { MemOceanSDK } from "@memocean/sdk";
import type { MemOceanConfig } from "@memocean/core";

export class MemOceanTools {
  private sdk: MemOceanSDK;

  constructor(config: MemOceanConfig) {
    this.sdk = new MemOceanSDK(config);
  }

  async oceanRemember(input: {
    content: string;
    summary: string;
    tags: string[];
    sessionId: string;
    projectId: string;
    agentType: string;
  }): Promise<{ content: string }> {
    await this.sdk.remember(input);
    return { content: "Memory saved successfully" };
  }

  async oceanRecall(query: string, tokenLimit: number = 1000): Promise<{ content: string }> {
    const memories = await this.sdk.recall(query, tokenLimit);
    return { content: JSON.stringify(memories, null, 2) };
  }

  async oceanContext(query: string, tokenLimit: number = 2000): Promise<{ content: string }> {
    const memories = await this.sdk.recall(query, tokenLimit);
    return { content: JSON.stringify(memories, null, 2) };
  }

  async oceanAnalyze(code: string): Promise<{ content: string }> {
    const result = await this.sdk.analyzeCode(code);
    return { content: JSON.stringify(result, null, 2) };
  }
}