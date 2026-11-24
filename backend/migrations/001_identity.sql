CREATE TABLE identity_users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity_email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity_users(id),
  purpose text NOT NULL CHECK (purpose = 'confirm_email'),
  token_hash bytea NOT NULL UNIQUE,
  key_id text NOT NULL,
  issued_by text NOT NULL CHECK (issued_by IN ('registration', 'resend')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz
);
CREATE UNIQUE INDEX identity_one_current_token ON identity_email_tokens (user_id, purpose)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX identity_token_history ON identity_email_tokens (user_id, issued_at);

CREATE TABLE identity_mail_outbox (
  token_id uuid PRIMARY KEY REFERENCES identity_email_tokens(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_id uuid,
  last_error text,
  sent_at timestamptz
);
CREATE INDEX identity_mail_ready ON identity_mail_outbox (available_at)
  WHERE state IN ('pending', 'sending');

CREATE TABLE identity_rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX identity_rate_expiry ON identity_rate_limits (expires_at);
