const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const KIND_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VALUE_MAX_BYTES = 1024 * 1024;

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} invalid format`);
}

function assertKind(kind: string): void {
  if (typeof kind !== "string" || !KIND_RE.test(kind)) throw new Error("Invalid kind");
}

function assertValue(value: string): void {
  if (typeof value !== "string") throw new Error("value must be string");
  if (new TextEncoder().encode(value).byteLength > VALUE_MAX_BYTES) throw new Error("value too large");
}

function assertTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error("Invalid TTL");
  return ttlSeconds;
}

export function kvKey(env: string, projectId: string, kind: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(env)) throw new Error("Invalid env");
  assertId(projectId, "projectId");
  assertKind(kind);
  assertId(id, "id");
  return `memocean:${env}:project:${projectId}:${kind}:${id}`;
}

export class KVAdapter {
  constructor(
    private kv: {
      get: (key: string) => Promise<string | null>;
      put: (key: string, value: string, options?: Record<string, unknown>) => Promise<void>;
      delete: (key: string) => Promise<void>;
    },
    private env = "prod"
  ) {}

  async getScoped(projectId: string, kind: string, id: string): Promise<string | null> {
    return this.kv.get(kvKey(this.env, projectId, kind, id));
  }

  async putScoped(
    projectId: string,
    kind: string,
    id: string,
    value: string,
    ttlSeconds = 900
  ): Promise<void> {
    assertValue(value);
    await this.kv.put(kvKey(this.env, projectId, kind, id), value, { expirationTtl: assertTtl(ttlSeconds) });
  }

  async deleteScoped(projectId: string, kind: string, id: string): Promise<void> {
    await this.kv.delete(kvKey(this.env, projectId, kind, id));
  }

  async getSession(projectId: string, sessionId: string): Promise<string | null> {
    return this.getScoped(projectId, "session", sessionId);
  }

  async putSession(projectId: string, sessionId: string, value: string, ttlSeconds = 900): Promise<void> {
    await this.putScoped(projectId, "session", sessionId, value, ttlSeconds);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    await this.deleteScoped(projectId, "session", sessionId);
  }
}
