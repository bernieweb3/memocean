import type { MemoryMetadata } from "./types.js";
import { v4 as uuidv4 } from "uuid";

type QueryFn = (sql: string, ...params: unknown[]) => Promise<void>;

export class SessionManager {
  constructor(private queryFn: QueryFn) {}

  async createSession(projectId: string, agentType: string, parentSessionId?: string): Promise<string> {
    const sessionId = uuidv4();
    const createdAt = new Date().toISOString();

    await this.linkSession(sessionId, projectId, agentType, parentSessionId, createdAt);

    return sessionId;
  }

  async linkSession(
    sessionId: string,
    projectId: string,
    agentType: string,
    parentSessionId?: string,
    createdAt?: string
  ): Promise<void> {
    if (!createdAt) createdAt = new Date().toISOString();

    await this.queryFn(
      `INSERT INTO sessions (id, project_id, agent_type, parent_session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      sessionId, projectId, agentType, parentSessionId || null, createdAt
    );
  }

  filterByRelevance(memories: MemoryMetadata[], tokenLimit: number): MemoryMetadata[] {
    return memories
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, tokenLimit);
  }
}