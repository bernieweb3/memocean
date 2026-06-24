# MemOcean MCP Server

[![Deploy](https://img.shields.io/badge/deployed-cloudflare-orange)](https://memocean-mcp-server.work-hackonteam.workers.dev/health)

**AI coding memory with zero-knowledge E2EE, powered by Cloudflare.**

MemOcean is the Web2 port of "Kage Sensei" — a persistent memory layer for AI coding agents. It replaces decentralized storage (Walrus/Arweave) with Cloudflare's high-performance edge stack (R2, D1, KV), while maintaining **Zero-Knowledge End-to-End Encryption** and **MCP Streamable HTTP** support.

AI agents (Claude Code, Cursor, Codex, etc.) use MemOcean to remember past sessions, learn project patterns, and recall relevant context — all without the server ever seeing plaintext data.

## Status

| Component | Status |
|-----------|--------|
| MCP Server | ✅ Deployed — `https://memocean-mcp-server.work-hackonteam.workers.dev` |
| E2EE Crypto (AES-256-GCM + HKDF) | ✅ Implemented |
| Storage Adapters (R2, D1, KV) | ✅ Implemented |
| SDK (`@memocean/sdk`) | ✅ Implemented |
| CI/CD (Trusted Publishing) | ✅ Configured |
| npm publish | ⏳ Pending

---

## Architecture

```
User / AI Agent Layer
  │
  ▼
MemOcean SDK (TypeScript)
  ├── Core Engine      — Session Mgmt, Token Budget, CCR Scoring
  ├── Crypto Module    — AES-256-GCM, HKDF Derivation
  └── Storage Adapter  — R2 (Blobs) + D1 (Metadata) + KV (State)
  │
  ▼
Cloudflare Infrastructure
  R2 (Encrypted Blobs) │ D1 (FTS5 Index) │ KV (Rate Limits)
```

## Monorepo Structure

```
memocean/
├── apps/
│   └── mcp-server/       # MCP server (Hono + Streamable HTTP / STDIO)
├── packages/
│   ├── core/             # SessionManager, CCREngine, TokenBudgeter, LLMProviderManager
│   ├── crypto/           # AES-256-GCM encrypt/decrypt, HKDF key derivation
│   ├── storage/          # R2, D1, KV adapters
│   └── sdk/              # MemOceanSDK — unified public API
├── docs/
│   ├── ARCHITECTURE.md
│   └── SDK-ARCHITECTURE.md
├── wrangler.toml         # Cloudflare Workers config
├── tsconfig.base.json
├── pnpm-workspace.yaml
└── package.json
```

## Packages

| Package | Description |
|---|---|
| `@memocean/core` | Session graph, CCR relevance scoring, token budgeting, LLM provider manager |
| `@memocean/crypto` | AES-256-GCM encryption/decryption, HKDF key derivation (Master → Project → Session) |
| `@memocean/storage` | Adapters for Cloudflare R2 (blobs), D1 (FTS5 metadata), KV (state/cache) |
| `@memocean/sdk` | Unified SDK — `remember()`, `recall()`, `analyzeCode()` |
| `memocean-mcp-server` | MCP server with Streamable HTTP (`POST/GET/DELETE /mcp`) and STDIO modes |

## MCP Tools

| Tool | Description |
|---|---|
| `ocean_remember` | Save encrypted memory (E2EE before upload to R2) |
| `ocean_recall` | FTS5 search across memory metadata via D1 |
| `ocean_context` | Fetch & budget memories for LLM context injection |
| `ocean_analyze` | Trigger Learn meta-learning on source code via LLM |

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the MCP server in dev mode
pnpm dev

# Build all packages
pnpm build

# Type-check
pnpm typecheck
```

### Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `MEMOCEAN_MASTER_SECRET` — high-entropy secret for HKDF key derivation

## Security

- **Zero-Knowledge:** Cloudflare infrastructure never sees plaintext. All blobs are encrypted client-side via AES-256-GCM before reaching R2.
- **Key Hierarchy:** `MasterSecret` (user-held) → `ProjectKey` (HKDF) → `SessionKey` (HKDF).
- **Metadata Privacy:** Only non-sensitive summaries and tags are stored in D1 for FTS5 search. Actual code and prompts remain in encrypted R2 blobs.

## Deployment

Deploy the MCP server to Cloudflare Workers:

```bash
pnpm deploy
```

Configure secrets:

```bash
npx wrangler secret put API_SECRET_KEY
npx wrangler secret put MEMOCEAN_MASTER_SECRET
```

## License

Apache 2.0 License
