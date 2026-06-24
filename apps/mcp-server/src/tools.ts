import { MemOceanSDK } from "@memocean/sdk";
import type { MemOceanConfig, MemoryInput } from "@memocean/core";

const MAX_QUERY_CHARS = 256;
const MAX_SUMMARY_CHARS = 2048;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 64;
const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_CODE_CHARS = 200 * 1024;
const MAX_TOKEN_LIMIT = 8000;

export function assertString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be string`);
  if (value.length === 0 || value.length > maxLen) throw new Error(`${name} invalid length`);
  return value;
}

export function assertNumberLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Must be finite number");
  return Math.min(Math.max(Math.floor(value), 1), max);
}

export function assertId(value: unknown, name: string): string {
  const s = assertString(value, name, 128);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(s)) throw new Error(`${name} invalid format`);
  return s;
}

export function assertStringArray(value: unknown, name: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be array`);
  if (value.length > maxItems) throw new Error(`${name} too many items`);
  return value.map((v, i) => assertString(v, `${name}[${i}]`, maxLen));
}

function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be object`);
  return value as Record<string, unknown>;
}

export function validateRememberArgs(value: unknown): MemoryInput {
  const input = assertObject(value, "arguments");
  const projectId = assertId(input.projectId, "projectId");

  if (input.sessionId !== undefined) {
    assertId(input.sessionId, "sessionId");
  }

  return {
    content: assertString(input.content, "content", MAX_CONTENT_CHARS),
    summary: assertString(input.summary, "summary", MAX_SUMMARY_CHARS),
    tags: assertStringArray(input.tags, "tags", MAX_TAGS, MAX_TAG_CHARS),
    projectId,
    agentType: assertString(input.agentType, "agentType", 64),
  };
}

export function validateRecallArgs(value: unknown, fallbackTokenLimit: number): { query: string; tokenLimit: number; projectId: string } {
  const input = assertObject(value, "arguments");
  return {
    query: assertString(input.query, "query", MAX_QUERY_CHARS),
    tokenLimit: assertNumberLimit(input.tokenLimit, fallbackTokenLimit, MAX_TOKEN_LIMIT),
    projectId: assertId(input.projectId, "projectId"),
  };
}

export function validateAnalyzeArgs(value: unknown): { code: string } {
  const input = assertObject(value, "arguments");
  return {
    code: assertString(input.code, "code", MAX_CODE_CHARS),
  };
}

export class MemOceanTools {
  private sdk: MemOceanSDK;

  constructor(config: MemOceanConfig) {
    this.sdk = new MemOceanSDK(config);
  }

  async oceanRemember(input: unknown): Promise<{ content: string }> {
    const safeInput = validateRememberArgs(input);
    await this.sdk.remember(safeInput);
    return { content: "Memory saved successfully" };
  }

  async oceanRecall(input: unknown): Promise<{ content: string }> {
    const { query, tokenLimit, projectId } = validateRecallArgs(input, 1000);
    const memories = await this.sdk.recall(query, tokenLimit, projectId);
    return { content: JSON.stringify(memories, null, 2) };
  }

  async oceanContext(input: unknown): Promise<{ content: string }> {
    const { query, tokenLimit, projectId } = validateRecallArgs(input, 2000);
    const memories = await this.sdk.recall(query, tokenLimit, projectId);
    return { content: JSON.stringify(memories, null, 2) };
  }

  async oceanAnalyze(input: unknown): Promise<{ content: string }> {
    const { code } = validateAnalyzeArgs(input);
    const result = await this.sdk.analyzeCode(code);
    return { content: JSON.stringify(result, null, 2) };
  }
}
