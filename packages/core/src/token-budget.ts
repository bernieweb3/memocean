// packages/core/src/token-budget.ts

import type { MemoryMetadata } from "./types.js";

export class TokenBudgeter {
  allocate(memories: MemoryMetadata[], rawLimit: number): MemoryMetadata[] {
    const tokenLimit = this.validateTokenLimit(rawLimit);

    const sorted = [...memories].sort((a, b) => {
      const relevanceDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
      if (relevanceDiff !== 0) return relevanceDiff;
      return Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0");
    });

    const selected: MemoryMetadata[] = [];
    let total = 0;

    for (const memory of sorted) {
      const cost = this.validateTokenCount(memory.tokenCount);
      if (cost > tokenLimit) continue;
      if (total + cost <= tokenLimit) {
        selected.push(memory);
        total += cost;
      }
    }

    return selected;
  }

  private validateTokenLimit(n: unknown): number {
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100_000) {
      throw new Error("Invalid token limit");
    }
    return n;
  }

  private validateTokenCount(n: unknown): number {
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100_000) {
      throw new Error("Invalid token count");
    }
    return n;
  }
}
