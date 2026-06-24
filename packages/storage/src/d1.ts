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

const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_QUERY_LIMIT = 50;
const MAX_SUMMARY_CHARS = 2048;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 64;

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} invalid format`);
}

function clampLimit(limit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) throw new Error("Invalid limit");
  return Math.min(Math.max(Math.floor(limit), 1), MAX_QUERY_LIMIT);
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

export function sanitizeFtsQuery(input: string): string {
  if (typeof input !== "string") throw new Error("Invalid search query");
  const tokens = input.toLowerCase().match(/[a-z0-9_/-]{2,32}/g)?.slice(0, 8) ?? [];
  if (tokens.length === 0) throw new Error("Invalid search query");
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function redactSensitiveMetadata(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED]");
}

function sanitizeSummary(summary: string): string {
  if (typeof summary !== "string" || summary.length === 0 || summary.length > MAX_SUMMARY_CHARS) {
    throw new Error("summary invalid length");
  }
  return redactSensitiveMetadata(summary);
}

function sanitizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) throw new Error("tags must be array");
  if (tags.length > MAX_TAGS) throw new Error("tags too many items");
  return tags.map((tag, i) => {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG_CHARS) {
      throw new Error(`tags[${i}] invalid length`);
    }
    return redactSensitiveMetadata(tag);
  });
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
    assertId(meta.id, "memoryId");
    assertId(meta.sessionId, "sessionId");
    assertId(meta.projectId, "projectId");

    const summary = sanitizeSummary(meta.summary);
    const tags = sanitizeTags(meta.tags);

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
      summary,
      JSON.stringify(tags),
      meta.relevanceScore,
      meta.tokenCount,
      meta.createdAt
    ).run();

    await this.db.prepare(
      `INSERT INTO memories_fts (id, summary, tags) VALUES (?, ?, ?)`
    ).bind(meta.id, summary, JSON.stringify(tags)).run();
  }

  async searchFTS(projectId: string, query: string, limit = 10): Promise<StoredMemoryMetadata[]> {
    assertId(projectId, "projectId");
    const safeQuery = sanitizeFtsQuery(query);
    const safeLimit = clampLimit(limit);

    const result = await this.db.prepare(
      `SELECT m.*, s.rank
       FROM memories m
       JOIN memories_fts s ON m.id = s.id
       WHERE m.project_id = ? AND memories_fts MATCH ?
       ORDER BY s.rank
       LIMIT ?`
    ).bind(projectId, safeQuery, safeLimit).all<{
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
      tags: parseTags(row.tags),
      relevanceScore: row.relevance_score,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    }));
  }

  async deleteByR2Key(projectId: string, r2Key: string): Promise<void> {
    assertId(projectId, "projectId");
    if (typeof r2Key !== "string" || r2Key.length === 0 || r2Key.length > 512) throw new Error("Invalid r2Key");

    const row = await this.db.prepare(
      "SELECT id FROM memories WHERE project_id = ? AND r2_key = ?"
    ).bind(projectId, r2Key).first<{ id: string }>();

    if (!row) return;

    await this.db.batch([
      this.db.prepare("DELETE FROM memories_fts WHERE id = ?").bind(row.id),
      this.db.prepare("DELETE FROM memories WHERE id = ? AND project_id = ?").bind(row.id, projectId),
    ]);
  }

  async delete(projectId: string, r2Key: string): Promise<void> {
    await this.deleteByR2Key(projectId, r2Key);
  }

  async insertSession(input: {
    id: string;
    projectId: string;
    agentType: string;
    parentSessionId?: string;
    createdAt: string;
    expiresAt: string;
    status: "active" | "expired" | "revoked";
  }): Promise<void> {
    assertId(input.id, "sessionId");
    assertId(input.projectId, "projectId");
    if (input.parentSessionId) assertId(input.parentSessionId, "parentSessionId");

    await this.db.prepare(
      `INSERT INTO sessions (id, project_id, agent_type, parent_session_id, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      input.id,
      input.projectId,
      input.agentType,
      input.parentSessionId ?? null,
      input.createdAt,
      input.expiresAt,
      input.status
    ).run();
  }

  async getSession(projectId: string, sessionId: string): Promise<{
    id: string;
    projectId: string;
    parentSessionId?: string;
    agentType: string;
    createdAt: string;
    expiresAt: string;
    status: "active" | "expired" | "revoked";
  } | null> {
    assertId(projectId, "projectId");
    assertId(sessionId, "sessionId");

    const row = await this.db.prepare(
      `SELECT id, project_id, parent_session_id, agent_type, created_at, expires_at, status
       FROM sessions
       WHERE project_id = ? AND id = ?`
    ).bind(projectId, sessionId).first<{
      id: string;
      project_id: string;
      parent_session_id: string | null;
      agent_type: string;
      created_at: string;
      expires_at: string;
      status: "active" | "expired" | "revoked";
    }>();

    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      parentSessionId: row.parent_session_id ?? undefined,
      agentType: row.agent_type,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
    };
  }
}
