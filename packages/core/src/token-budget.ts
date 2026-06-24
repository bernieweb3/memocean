// packages/core/src/token-budget.ts

import type { MemoryMetadata } from "./types.js";

export class TokenBudgeter {
  allocate(memories: MemoryMetadata[], tokenLimit: number): MemoryMetadata[] {
    const sortedMemories = memories
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const selected: MemoryMetadata[] = [];
    let totalTokens = 0;

    for (const memory of sortedMemories) {
      if (totalTokens + memory.tokenCount <= tokenLimit) {
        selected.push(memory);
        totalTokens += memory.tokenCount;
      } else {
        break;
      }
    }

    return selected;
  }
}