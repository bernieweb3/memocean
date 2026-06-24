export class R2Adapter {
  constructor(private bucket: {
    put: (key: string, value: Uint8Array | ArrayBuffer | string, options?: Record<string, unknown>) => Promise<unknown>;
    get: (key: string) => Promise<{
      body?: ReadableStream;
      arrayBuffer?: () => Promise<ArrayBuffer>;
    } | null>;
    delete: (key: string) => Promise<void>;
  }) {}

  async put(key: string, data: Uint8Array, customMetadata?: Record<string, string>): Promise<void> {
    const options: Record<string, unknown> = {};
    if (customMetadata) {
      options.customMetadata = customMetadata;
    }
    await this.bucket.put(key, data, options);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const ab = await object.arrayBuffer?.();
    if (!ab) return null;
    return new Uint8Array(ab);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}