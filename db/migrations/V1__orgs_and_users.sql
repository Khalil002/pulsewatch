-- Organisations (tenants) and their members. Shared by every backend; applied once by Flyway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE orgs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
    -- Public status pages live at /status/{slug}.
    slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    -- Signs outgoing alert webhooks (HMAC-SHA256).
    webhook_secret text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    email         text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id);

-- Demo organisation and owner (password: admin1234). Change it before exposing the app.
INSERT INTO orgs (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000d01', 'Demo', 'demo');
INSERT INTO users (id, org_id, email, password_hash, role) VALUES
    ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000d01', 'admin@pulsewatch.local',
     '$2a$10$R.zyHeoOV2B30kSJKC5h/OsuCmZq2x0Q0hG1ZaL18kc/re3Q1s9wa', 'owner');
