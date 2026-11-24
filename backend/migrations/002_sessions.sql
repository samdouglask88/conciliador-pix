CREATE TABLE identity_sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced boolean NOT NULL DEFAULT false,
  CHECK (octet_length(token_hash) = 32),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX identity_session_expiry ON identity_sessions (absolute_expires_at);
CREATE INDEX identity_session_user ON identity_sessions (user_id);
