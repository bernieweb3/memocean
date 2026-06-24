# MemOcean SDK Architecture

The **MemOcean SDK** is a TypeScript-first library designed to act as the secure bridge between AI Coding Agents (Claude Code, Cursor, Codex, etc.) and the Cloudflare Infrastructure (R2, D1, KV). 

It implements a **Zero-Knowledge** architecture, ensuring that while metadata is indexed for search, the actual content of your code and prompts remains encrypted end-to-end.

## 1. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                     User / AI Agent Layer                       │
│   Claude Code │ Cursor │ Codex │ Factory CLI │ Custom Scripts  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   MemOcean SDK (TypeScript)                     │
│                                                                 │
│  ┌─────────────────┐   ┌──────────────────┐                    │
│  │  Core Engine    │   │  Crypto Module   │                    │
│  │ - Session Mgmt  │   │ - AES-256-GCM    │                    │
│  │ - Token Budget  │   │ - HKDF Derivation│                    │
│  │ - CCR Scoring   │   │ - ECDH Sharing   │                    │
│  └────────┬────────┘   └────────┬─────────┘                    │
│           │                     │                               │
│  ┌────────▼─────────────────────▼─────────────────────────────┐ │
│  │               Storage Adapter (Cloudflare Bindings)        │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │ │
│  │  │ R2 Adapter   │  │ D1 Adapter   │  │ KV Adapter       │ │ │
│  │  │ (Blob Store) │  │ (Metadata)   │  │ (State/Cache)    │ │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Cloudflare Infrastructure                      │
│   R2 (Encrypted Blobs) │ D1 (FTS5 Index) │ KV (Rate Limits)    │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Module Breakdown

### 2.1 `@memocean/core` (The Brain)
*   **SessionManager:** Handles the creation of `sessionId`, linking sessions (parent-child), and managing the "Session Graph" for context continuity.
*   **CCREngine (Contextual Compression Ratio):** Calculates a relevance score (0.0–1.0) for every piece of data. This ensures that when an AI asks for context, we only fetch the most valuable memories that fit within the token budget.
*   **TokenBudgeter:** Ensures that the total size of recalled memories doesn't exceed the LLM's context window.

### 2.2 `@memocean/crypto` (The Vault)
*   **KeyDerivation:** Uses **HKDF** to derive a `ProjectKey` from a `MasterSecret`. This means you only need to remember one secret; the SDK handles the rest.
*   **AESEncryptor:** Implements **AES-256-GCM** for authenticated encryption. 
*   **ECDHShare:** Allows team members to share project access without sharing their master secrets.

### 2.3 `@memocean/storage` (The Bridge)
*   **R2Adapter:** Handles multipart uploads for large codebases and retrieves encrypted blobs.
*   **D1Adapter:** Manages the SQLite schema, including FTS5 queries for fast text search across summaries and tags.
*   **KVAdapter:** Handles API key validation and ephemeral session states for the MCP server.

## 3. Data Flow: Saving a Memory (`ocean_remember`)

1.  **Input:** AI Agent sends a prompt/completion pair + metadata (tags, agent type).
2.  **Encryption:** SDK derives the `SessionKey` and encrypts the payload using **AES-256-GCM**.
3.  **Upload:** 
    *   The **Ciphertext** is uploaded to **R2** with a UUID key.
    *   The **Metadata** (summary, tags, R2 key, relevance score) is inserted into **D1**.
4.  **Indexing:** D1 automatically updates the **FTS5** virtual table for instant searchability.

## 4. Data Flow: Recalling Context (`ocean_context`)

1.  **Query:** AI Agent asks for context related to "auth module".
2.  **Search:** SDK queries **D1 FTS5** for metadata matching "auth".
3.  **Scoring:** **CCREngine** ranks results by relevance and recency.
4.  **Budgeting:** **TokenBudgeter** selects the top N results that fit the current token limit.
5.  **Fetch & Decrypt:** SDK fetches the corresponding blobs from **R2**, decrypts them locally using the `MasterSecret`, and returns the plaintext to the AI Agent.

## 5. LLM Provider Integration (Learn)

The SDK includes a unified `LLMProviderManager` to support the "Learn" meta-learning engine. It uses a fallback strategy starting with **Groq** for speed.

| Provider | Base URL | Primary Use Case |
| :--- | :--- | :--- |
| **Groq** | `https://api.groq.com/openai/v1` | Primary: Ultra-fast code pattern analysis. |
| **Ollama Cloud** | `https://ollama.com/v1/` | Fallback: High-context reasoning (Minimax-M3). |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Backup: Access to 100+ models. |
| **NVIDIA NIM** | `https://integrate.api.nvidia.com/v1` | Enterprise: Proprietary model access. |

## 6. Implementation Skeleton

Below is the core structure of the SDK entry point:

```typescript
import { CryptoModule } from './crypto';
import { StorageAdapter } from './storage';
import { SessionManager } from './core/session';
import { LLMProviderManager } from './core/llm-manager';

export class MemOceanSDK {
  private crypto: CryptoModule;
  private storage: StorageAdapter;
  private sessions: SessionManager;
  private llm: LLMProviderManager;

  constructor(config: MemOceanConfig) {
    this.crypto = new CryptoModule(config.masterSecret);
    this.storage = new StorageAdapter(config.cloudflareBindings);
    this.sessions = new SessionManager();
    this.llm = new LLMProviderManager(config.llmConfig);
  }

  /**
   * Save a memory to the Ocean.
   * 1. Encrypt via AES-256-GCM
   * 2. Upload to R2 and index in D1
   */
  async remember(input: MemoryInput): Promise<void> {
    const encrypted = await this.crypto.encrypt(input.content, input.sessionId);
    const r2Key = await this.storage.r2.put(encrypted);
    await this.storage.d1.insertMetadata({ ...input, r2Key });
  }

  /**
   * Recall context for an AI Agent.
   * 1. Search D1 FTS5
   * 2. Score via CCREngine
   * 3. Fetch from R2 and Decrypt
   */
  async recall(query: string, tokenLimit: number): Promise<string[]> {
    const metadata = await this.storage.d1.search(query);
    const relevant = this.sessions.filterByRelevance(metadata, tokenLimit);
    const blobs = await Promise.all(relevant.map(m => this.storage.r2.get(m.r2Key)));
    return blobs.map(b => this.crypto.decrypt(b));
  }

  /**
   * Analyze code using the Learn engine.
   * Falls back from Groq -> Ollama Cloud -> OpenRouter.
   */
  async analyzeCode(codeSnippet: string): Promise<AnalysisResult> {
    return this.llm.analyzeCodeSnippet(codeSnippet);
  }
}
```

## 7. Security Model

*   **Zero-Knowledge:** The Cloudflare infrastructure (Workers, R2, D1) never sees plaintext data. All blobs are encrypted client-side.
*   **Key Hierarchy:** 
    *   `MasterSecret` (User-held) ➔ `ProjectKey` (HKDF) ➔ `SessionKey` (HKDF).
*   **Metadata Privacy:** Only non-sensitive summaries and tags are stored in D1 to enable FTS5 search. Actual code logic remains in encrypted R2 blobs.
