export class KVAdapter {
  constructor(private kv: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: Record<string, unknown>) => Promise<void>;
    delete: (key: string) => Promise<void>;
  }) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key);
  }

  async put(key: string, value: string, options?: { expiration?: number; metadata?: Record<string, unknown> }): Promise<void> {
    await this.kv.put(key, value, options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}