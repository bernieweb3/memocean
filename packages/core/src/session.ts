import type { MemoryMetadata, Session } from "./types.js";
import { TokenBudgeter } from "./token-budget.js";

type InsertSessionFn = (session: Session) => Promise<void>;
type GetSessionFn = (projectId: string, sessionId: string) => Promise<Session | null>;

const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} invalid format`);
}

function assertAgentType(agentType: string): void {
  if (typeof agentType !== "string" || agentType.length === 0 || agentType.length > 64) {
    throw new Error("agentType invalid length");
  }
}

export class SessionManager {
  private budgeter = new TokenBudgeter();

  constructor(
    private insertSessionFn: InsertSessionFn,
    private getSessionFn?: GetSessionFn,
    private ttlMs = DEFAULT_SESSION_TTL_MS
  ) {}

  async createSession(projectId: string, agentType: string, parentSessionId?: string): Promise<string> {
    assertId(projectId, "projectId");
    assertAgentType(agentType);
    if (parentSessionId) assertId(parentSessionId, "parentSessionId");

    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();

    await this.insertSessionFn({
      id: sessionId,
      projectId,
      agentType,
      parentSessionId,
      createdAt,
      expiresAt,
      status: "active",
    });

    return sessionId;
  }

  async assertSessionActive(projectId: string, sessionId: string): Promise<void> {
    assertId(projectId, "projectId");
    assertId(sessionId, "sessionId");
    if (!this.getSessionFn) throw new Error("Session lookup unavailable");

    const session = await this.getSessionFn(projectId, sessionId);
    if (!session || session.status !== "active") throw new Error("Invalid session");
    if (Date.now() > Date.parse(session.expiresAt)) throw new Error("Session expired");
  }

  filterByRelevance(memories: MemoryMetadata[], tokenLimit: number): MemoryMetadata[] {
    return this.budgeter.allocate(memories, tokenLimit);
  }
}
