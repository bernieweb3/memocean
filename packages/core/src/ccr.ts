// packages/core/src/ccr.ts

import type { MemoryMetadata } from "./types.js";

export class CCREngine {
  calculateRelevanceScore(memory: MemoryMetadata, query: string): number {
    let score = 0.0;

    if (memory.summary.toLowerCase().includes(query.toLowerCase())) {
      score += 0.6;
    }

    if (memory.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase()))) {
      score += 0.3;
    }

    const recencyScore = this.calculateRecencyScore(memory.createdAt);
    score += recencyScore * 0.1;

    return Math.min(score, 1.0);
  }

  private calculateRecencyScore(createdAt: string): number {
    const now = new Date();
    const created = new Date(createdAt);
    const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays <= 1) return 1.0;
    if (diffDays <= 7) return 0.8;
    if (diffDays <= 30) return 0.6;
    if (diffDays <= 90) return 0.4;
    return 0.2;
  }
}