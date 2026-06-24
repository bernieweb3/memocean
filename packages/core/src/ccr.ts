// packages/core/src/ccr.ts

import type { MemoryMetadata } from "./types.js";

function calculateRelevance(memory: MemoryMetadata, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 256) {
    throw new Error("Invalid query");
  }

  let score = 0;
  const summary = typeof memory.summary === "string" ? memory.summary.toLowerCase() : "";
  const tags = Array.isArray(memory.tags) ? memory.tags : [];

  if (summary.includes(normalizedQuery)) score += 0.5;
  if (tags.some(tag => typeof tag === "string" && tag.toLowerCase().includes(normalizedQuery))) score += 0.3;

  const createdMs = Date.parse(memory.createdAt);
  if (!Number.isFinite(createdMs)) return score;

  const diffMs = Date.now() - createdMs;
  if (diffMs < 0) return score;

  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays <= 1) score += 0.2;
  else if (diffDays <= 7) score += 0.1;

  return Math.min(score, 1.0);
}

export class CCREngine {
  calculateRelevanceScore(memory: MemoryMetadata, query: string): number {
    return calculateRelevance(memory, query);
  }
}

export { calculateRelevance };
