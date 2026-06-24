const ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const ALLOWED_METADATA = new Set(["projectId", "memoryId", "alg", "keyVersion", "createdAt"]);

export function buildR2Key(projectId: string, memoryId: string): string {
  if (!ID_RE.test(projectId)) throw new Error("Invalid projectId");
  if (!ID_RE.test(memoryId)) throw new Error("Invalid memoryId");
  return `projects/${projectId}/memories/${memoryId}.bin`;
}

export function sanitizeMetadata(input: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_METADATA.has(key)) continue;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) continue;
    if (typeof value !== "string") throw new Error("Metadata value must be string");
    if (value.length > 256) throw new Error("Metadata value too large");
    if (/[\r\n]/.test(value)) throw new Error("Invalid metadata value");
    out[key] = value;
  }

  return out;
}

export class R2Adapter {
  constructor(private bucket: {
    put: (key: string, value: Uint8Array | ArrayBuffer | string, options?: Record<string, unknown>) => Promise<unknown>;
    get: (key: string) => Promise<{
      body?: ReadableStream;
      arrayBuffer?: () => Promise<ArrayBuffer>;
    } | null>;
    delete: (key: string) => Promise<void>;
  }) {}

  async put(
    projectId: string,
    memoryId: string,
    data: Uint8Array,
    meta?: Record<string, string>
  ): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new Error("data must be Uint8Array");
    if (data.byteLength === 0 || data.byteLength > MAX_BLOB_BYTES) throw new Error("Invalid blob size");

    const key = buildR2Key(projectId, memoryId);
    const options: Record<string, unknown> = {
      customMetadata: sanitizeMetadata({
        projectId,
        memoryId,
        ...(meta ?? {}),
      }),
    };

    await this.bucket.put(key, data, options);
  }

  async get(projectId: string, memoryId: string): Promise<Uint8Array | null> {
    const key = buildR2Key(projectId, memoryId);
    const object = await this.bucket.get(key);
    if (!object) return null;

    const ab = await object.arrayBuffer?.();
    if (!ab) return null;
    if (ab.byteLength > MAX_BLOB_BYTES) throw new Error("Blob too large");

    return new Uint8Array(ab);
  }

  async delete(projectId: string, memoryId: string): Promise<void> {
    const key = buildR2Key(projectId, memoryId);
    await this.bucket.delete(key);
  }
}
