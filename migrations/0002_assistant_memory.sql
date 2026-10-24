CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS assistant_threads_user_updated
  ON assistant_threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_history (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, thread_id)
    REFERENCES assistant_threads(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS assistant_history_user_thread_created
  ON assistant_history(user_id, thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS assistant_history_user_created
  ON assistant_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_memories (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS assistant_memories_user_created
  ON assistant_memories(user_id, created_at DESC);
