-- Approved account model: users and auth_sessions only.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  disabled_at_ms INTEGER,
  reset_token_hash TEXT,
  reset_expires_at_ms INTEGER
);
CREATE UNIQUE INDEX idx_users_reset_token ON users(reset_token_hash) WHERE reset_token_hash IS NOT NULL;
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, expires_at_ms);
