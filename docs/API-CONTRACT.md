# MemOcean MCP API Contract

**Base URL (production):** `https://memocean-mcp-server.work-hackonteam.workers.dev`

**Transport:** MCP Streamable HTTP / SSE

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | JSON-RPC tool execution |
| `/sse` | GET | SSE stream (endpoint event → `/mcp`) |
| `/health` | GET | Health check |

**Auth:** `Authorization: Bearer <API_SECRET_KEY>` header (all endpoints except `/health` and `/sse`).

**Content-Type:** `application/json`

**Body size limit:** 1 MB

---

## Tools

### ocean_remember

Save an encrypted memory.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ocean_remember",
    "arguments": {
      "content":      "string (1..65536 chars)  — plain text to encrypt & store",
      "summary":      "string (1..2048 chars)  — plain text summary (indexed in FTS5)",
      "tags":         "string[] (1..20 items, each 1..64 chars) — search tags",
      "projectId":    "string (8..128 chars)   — regex: ^[a-zA-Z0-9_-]+$",
      "agentType":    "string (1..64 chars)    — e.g. opencode, claude-code"
    }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "Memory saved successfully" }
    ]
  }
}
```

**Data flow:**
1. Create session with `projectId` + `agentType` in D1 `sessions` table
2. Encrypt `content` with AES-256-GCM (key derived via HKDF: MasterSecret → ProjectKey → SessionKey)
3. Store encrypted envelope (JSON with version, alg, IV, ciphertext) in R2 at `projects/{projectId}/memories/{memoryId}.bin`
4. Index plaintext `summary` + `tags` in D1 `memories` table + FTS5 virtual table `memories_fts`

**Constraints:**

| Field | Validation | Default | Error |
|-------|------------|---------|-------|
| `content` | 1 ≤ len ≤ 65536 | required | `content invalid length` |
| `summary` | 1 ≤ len ≤ 2048 | `"Memory from {agentType}"` | `summary invalid length` |
| `tags` | 1..20 items, each 1..64 chars | `["general"]` | `tags invalid length` |
| `projectId` | 8..128 chars, `^[a-zA-Z0-9_-]+$` | required | `projectId invalid format` |
| `agentType` | 1 ≤ len ≤ 64 | `"mcp-client"` | `agentType invalid length` |

---

### ocean_recall

Search and decrypt memories via FTS5.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "ocean_recall",
    "arguments": {
      "query":      "string (1..256 chars)   — FTS5 search query",
      "projectId":  "string (8..128 chars)   — regex: ^[a-zA-Z0-9_-]+$",
      "tokenLimit": "number (1..8000, default: 1000) — max tokens to return"
    }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[\"decrypted memory content 1\", \"decrypted memory content 2\"]"
      }
    ]
  }
}
```

Empty result:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "[]" }
    ]
  }
}
```

**Data flow:**
1. Sanitize `query` → extract alphanumeric tokens (2..32 chars, max 8 tokens) → wrap in quotes for FTS5
2. Search D1 via `SELECT ... FROM memories m JOIN memories_fts s ON m.id = s.id WHERE m.project_id = ? AND memories_fts MATCH ?`
3. Score results via CCR engine (relevance: 0.0–1.0)
4. Allocate up to `tokenLimit` tokens via TokenBudgeter
5. Fetch encrypted envelopes from R2 at `projects/{projectId}/memories/{memoryId}.bin`
6. Decrypt each envelope with AES-256-GCM + HKDF-derived keys
7. Return array of plaintext content strings

**FTS5 query sanitization rules:**
- Lowercases input
- Extracts tokens matching `[a-z0-9_/-]{2,32}`
- Max 8 tokens per query
- Each token escaped for FTS5 (double quotes)

**Constraints:**

| Field | Validation | Error |
|-------|------------|-------|
| `query` | 1 ≤ len ≤ 256, at least 1 valid token | `query invalid length` / `Invalid search query` |
| `projectId` | 8..128 chars, `^[a-zA-Z0-9_-]+$` | `projectId invalid format` |
| `tokenLimit` | 1..8000, default 1000 | `Invalid token limit` |

---

### ocean_context

Same as `ocean_recall` but with a higher default `tokenLimit` (2000) — designed for LLM context window injection.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "ocean_context",
    "arguments": {
      "query":      "string (1..256 chars)   — FTS5 search query",
      "projectId":  "string (8..128 chars)   — regex: ^[a-zA-Z0-9_-]+$",
      "tokenLimit": "number (1..8000, default: 2000) — max tokens to return"
    }
  }
}
```

**Response:** Same format as `ocean_recall`.

**Constraints:** Same as `ocean_recall`.

---

### ocean_analyze

Analyze code via the Learn engine (multi-LLM fallback: Groq → OpenRouter → NVIDIA).

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "ocean_analyze",
    "arguments": {
      "code": "string (1..204800 chars) — source code to analyze"
    }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"lessons\": [...],\n  \"patterns\": [...],\n  \"summary\": \"...\"\n}"
      }
    ]
  }
}
```

**Data flow:**
1. LLMProviderManager iterates through configured providers in order: Groq → OpenRouter → NVIDIA
2. First successful response wins; on failure falls to next provider
3. LLM extracts `lessons`, `patterns`, `summary` from the code

**Constraints:**

| Field | Validation | Error |
|-------|------------|-------|
| `code` | 1 ≤ len ≤ 204800 | `code invalid length` |

---

## Error Handling

### JSON-RPC Errors

| Code | Message | When |
|------|---------|------|
| `-32602` | *descriptive validation message* | Invalid arguments (HTTP 400) |
| `-32601` | Method not found | Unknown `method` or `name` |
| `-32601` | Tool not found | Unknown tool in `tools/call` |
| `-32603` | Internal error | Unexpected server error (HTTP 500) |

### Auth Errors

```json
{ "error": "Unauthorized" }
```

Status: `401`

### Validation Errors

Returned as `-32602 Invalid params` (HTTP 400) with a descriptive message:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "content invalid length" }
}
```
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32603, "message": "Internal error" }
}
```

## SSE Transport

Connect to `/sse` for MCP SSE transport:

```
→ GET /sse
← event: endpoint
← data: https://memocean-mcp-server.work-hackonteam.workers.dev/mcp
←
← : keepalive
←
```

After receiving the `endpoint` event, send JSON-RPC messages via `POST /mcp` as described above.

## Environment Variables (Server)

| Variable | Required | Description |
|----------|----------|-------------|
| `API_SECRET_KEY` | ✅ | 32+ char secret for Bearer auth |
| `MEMOCEAN_MASTER_SECRET` | for E2EE | High-entropy key for HKDF derivation |
| `MEMOCEAN_PROJECT_SALT` | for E2EE | 32-byte hex salt per project |
| `GROQ_API_KEY` | for analyze | Groq API key (primary LLM) |
| `OPENROUTER_API_KEY` | for analyze | OpenRouter fallback |
| `NVIDIA_NIM_API_KEY` | for analyze | NVIDIA NIM fallback |
| `MEMOCEAN_ALLOW_EXTERNAL_LLM` | optional | Set `"true"` to enable external LLM for analyze (default: `"false"`) |

## SDK Usage (TypeScript)

```typescript
import { MemOceanSDK } from "@memocean/sdk";

const sdk = new MemOceanSDK({
  masterSecret: process.env.MEMOCEAN_MASTER_SECRET,
  projectSalt: process.env.MEMOCEAN_PROJECT_SALT,
  bindings: { DB, R2, KV },
  llm: { primaryProvider: "groq", groq: { apiKey: "..." } },
});

await sdk.remember({
  content: "...",
  summary: "...",
  tags: ["tag1", "tag2"],
  projectId: "my-project-001",
  agentType: "opencode",
});

const memories = await sdk.recall("search query", 5000, "my-project-001");
```
