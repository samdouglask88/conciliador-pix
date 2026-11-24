ALTER TABLE identity_users ADD COLUMN password_version bigint NOT NULL DEFAULT 0;
ALTER TABLE identity_email_tokens DROP CONSTRAINT identity_email_tokens_purpose_check;
ALTER TABLE identity_email_tokens ADD CHECK (purpose IN ('confirm_email','reset_password','invite'));
ALTER TABLE identity_email_tokens ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE identity_email_tokens ADD COLUMN recipient text;
ALTER TABLE identity_email_tokens ADD CHECK (
  (purpose = 'invite' AND user_id IS NULL AND recipient IS NOT NULL)
  OR (purpose <> 'invite' AND user_id IS NOT NULL AND recipient IS NULL)
);

CREATE TABLE tenant_companies (
  id uuid PRIMARY KEY, name text NOT NULL, version bigint NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES identity_users(id),
  request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by, request_key)
);
CREATE TABLE tenant_members (
  company_id uuid NOT NULL REFERENCES tenant_companies(id),
  user_id uuid NOT NULL REFERENCES identity_users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','finance','viewer')),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY (company_id,user_id)
);
CREATE INDEX tenant_members_user ON tenant_members(user_id) WHERE active;
CREATE TABLE tenant_invites (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES tenant_companies(id),
  email text NOT NULL, role text NOT NULL CHECK (role IN ('owner','admin','finance','viewer')),
  token_id uuid NOT NULL UNIQUE REFERENCES identity_email_tokens(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_pending_invite ON tenant_invites(company_id,email) WHERE status='pending';
CREATE TABLE tenant_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid REFERENCES tenant_companies(id), actor text NOT NULL,
  action text NOT NULL, target text NOT NULL, outcome text NOT NULL,
  correlation uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_audit_company ON tenant_audit(company_id,id DESC);
CREATE FUNCTION prevent_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END;
$$;
CREATE TRIGGER tenant_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant_audit
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_change();

CREATE TABLE tenant_clients (
  company_id uuid NOT NULL REFERENCES tenant_companies(id), id uuid NOT NULL,
  name text NOT NULL, email text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id)
);
CREATE TABLE tenant_charges (
  company_id uuid NOT NULL REFERENCES tenant_companies(id), id uuid NOT NULL, client_id uuid,
  description text NOT NULL, amount int NOT NULL CHECK(amount BETWEEN 1 AND 1000000000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,client_id) REFERENCES tenant_clients(company_id,id)
);
CREATE TABLE tenant_providers (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES tenant_companies(id),
  kind text NOT NULL CHECK (kind = 'simulator'), UNIQUE(company_id,kind), UNIQUE(company_id,id)
);
CREATE TABLE tenant_payments (
  company_id uuid NOT NULL REFERENCES tenant_companies(id), id uuid NOT NULL, provider_id uuid NOT NULL,
  charge_id uuid, external_id uuid NOT NULL, amount int NOT NULL CHECK(amount BETWEEN 1 AND 1000000000),
  settled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,provider_id,external_id),
  FOREIGN KEY(company_id,provider_id) REFERENCES tenant_providers(company_id,id),
  FOREIGN KEY(company_id,charge_id) REFERENCES tenant_charges(company_id,id)
);
CREATE UNIQUE INDEX tenant_one_settlement ON tenant_payments(company_id,charge_id) WHERE settled;
CREATE TABLE tenant_events (
  company_id uuid NOT NULL REFERENCES tenant_companies(id), id uuid NOT NULL, provider_id uuid NOT NULL,
  external_id uuid NOT NULL, external_payment_id uuid NOT NULL, requested_charge_id uuid NOT NULL,
  amount int NOT NULL CHECK(amount BETWEEN 1 AND 1000000000), fingerprint text NOT NULL,
  payment_id uuid, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,provider_id,external_id),
  FOREIGN KEY(company_id,provider_id) REFERENCES tenant_providers(company_id,id),
  FOREIGN KEY(company_id,payment_id) REFERENCES tenant_payments(company_id,id)
);
CREATE TABLE tenant_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, company_id uuid NOT NULL,
  event_id uuid NOT NULL, fingerprint text NOT NULL, outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,event_id) REFERENCES tenant_events(company_id,id)
);
CREATE TABLE tenant_reviews (
  company_id uuid NOT NULL, id uuid NOT NULL, payment_id uuid NOT NULL, event_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('divergent','extra','unmatched')),
  expected int, received int NOT NULL, resolution text CHECK(resolution IN ('close','settle','refund_recorded')),
  justification text, resolved_by uuid REFERENCES identity_users(id), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id), UNIQUE(company_id,payment_id),
  FOREIGN KEY(company_id,payment_id) REFERENCES tenant_payments(company_id,id),
  FOREIGN KEY(company_id,event_id) REFERENCES tenant_events(company_id,id)
);
CREATE TABLE tenant_cache (
  company_id uuid REFERENCES tenant_companies(id), key text NOT NULL,
  version bigint NOT NULL, value jsonb NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(company_id,key)
);
CREATE INDEX tenant_cache_expiry ON tenant_cache(expires_at);

CREATE INDEX tenant_clients_order ON tenant_clients(company_id,created_at DESC,id);
CREATE INDEX tenant_charges_order ON tenant_charges(company_id,created_at DESC,id);
CREATE INDEX tenant_payments_by_charge ON tenant_payments(company_id,charge_id,created_at DESC);
CREATE INDEX tenant_payments_totals ON tenant_payments(company_id,created_at);
CREATE INDEX tenant_events_order ON tenant_events(company_id,created_at DESC,id);
CREATE INDEX tenant_deliveries_event ON tenant_deliveries(company_id,event_id,id DESC);
CREATE INDEX tenant_reviews_order ON tenant_reviews(company_id,created_at DESC,id);
