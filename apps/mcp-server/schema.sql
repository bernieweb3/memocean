CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  parent_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  relevance_score REAL NOT NULL DEFAULT 0.0,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_r2key ON memories(project_id, r2_key);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  summary,
  tags
);
