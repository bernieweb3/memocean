export interface StoredMemoryMetadata {
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

export class D1Adapter {
  constructor(private db: {
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
  }) {}

  async insertMetadata(meta: StoredMemoryMetadata): Promise<void> {
    await this.db.prepare(
      `INSERT INTO memories (
        id, session_id, project_id, r2_key, summary, tags,
        relevance_score, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      meta.id,
      meta.sessionId,
      meta.projectId,
      meta.r2Key,
      meta.summary,
      JSON.stringify(meta.tags),
      meta.relevanceScore,
      meta.tokenCount,
      meta.createdAt
    ).run();

    await this.db.prepare(
      `INSERT INTO memories_fts (id, summary, tags) VALUES (?, ?, ?)`
    ).bind(meta.id, meta.summary, JSON.stringify(meta.tags)).run();
  }

  async searchFTS(query: string, limit: number = 10): Promise<StoredMemoryMetadata[]> {
    const result = await this.db.prepare(
      `SELECT m.*, s.rank FROM memories m JOIN memories_fts s ON m.id = s.id WHERE memories_fts MATCH ? ORDER BY s.rank LIMIT ?`
    ).bind(query, limit).all<{
      id: string;
      session_id: string;
      project_id: string;
      r2_key: string;
      summary: string;
      tags: string;
      relevance_score: number;
      token_count: number;
      created_at: string;
      rank: number;
    }>();

    return result.results.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      r2Key: row.r2_key,
      summary: row.summary,
      tags: JSON.parse(row.tags),
      relevanceScore: row.relevance_score,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    }));
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM memories WHERE r2_key = ?").bind(key).run();
    await this.db.prepare("DELETE FROM memories_fts WHERE id = ?").bind(key).run();
  }

  async query(sql: string, ...params: unknown[]): Promise<void> {
    await this.db.prepare(sql).bind(...params).run();
  }
}