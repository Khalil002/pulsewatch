-- Monitors, their check history, incidents and the alert delivery queue.
-- Every tenant-owned row carries org_id so row-level security (V3) can filter on it directly.

CREATE TABLE api_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    prefix       text NOT NULL,
    -- Only the SHA-256 of the key is stored; the key itself is shown once.
    key_hash     text NOT NULL UNIQUE,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

CREATE TABLE monitors (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    url               text NOT NULL CHECK (url ~ '^https?://' AND char_length(url) <= 2048),
    method            text NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
    interval_sec      integer NOT NULL DEFAULT 60 CHECK (interval_sec BETWEEN 10 AND 3600),
    timeout_ms        integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 500 AND 10000),
    expected_status   integer NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
    alert_webhook_url text CHECK (alert_webhook_url ~ '^https?://' AND char_length(alert_webhook_url) <= 2048),
    paused            boolean NOT NULL DEFAULT false,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'up', 'down')),
    next_check_at     timestamptz NOT NULL DEFAULT now(),
    last_checked_at   timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    -- Lets child tables reference (id, org_id) so a row can never point at another tenant's monitor.
    UNIQUE (id, org_id)
);
CREATE INDEX monitors_org_idx ON monitors (org_id, created_at DESC);
-- The scheduler's "what is due" query: WHERE NOT paused AND next_check_at <= now().
CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE NOT paused;

CREATE TABLE check_results (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    monitor_id  uuid NOT NULL,
    org_id      uuid NOT NULL,
    checked_at  timestamptz NOT NULL DEFAULT now(),
    ok          boolean NOT NULL,
    status_code integer,
    latency_ms  integer NOT NULL CHECK (latency_ms >= 0),
    error       text,
    FOREIGN KEY (monitor_id, org_id) REFERENCES monitors (id, org_id) ON DELETE CASCADE
);
CREATE INDEX check_results_monitor_idx ON check_results (monitor_id, checked_at DESC);
-- Retention deletes by age across all monitors.
CREATE INDEX check_results_age_idx ON check_results (checked_at);

CREATE TABLE incidents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    monitor_id  uuid NOT NULL,
    org_id      uuid NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    cause       text NOT NULL,
    FOREIGN KEY (monitor_id, org_id) REFERENCES monitors (id, org_id) ON DELETE CASCADE,
    CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);
-- At most one open incident per monitor, even with several schedulers racing.
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents (monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_org_idx ON incidents (org_id, started_at DESC);

-- A work queue in Postgres: workers claim rows with FOR UPDATE SKIP LOCKED, so the job is
-- written in the same transaction as the incident that caused it (no lost or phantom alerts).
CREATE TABLE alert_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL,
    monitor_id      uuid NOT NULL,
    incident_id     uuid REFERENCES incidents (id) ON DELETE SET NULL,
    event           text NOT NULL CHECK (event IN ('monitor.down', 'monitor.up')),
    target_url      text NOT NULL,
    -- The exact JSON body that is sent and signed, frozen at enqueue time.
    payload         text NOT NULL,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    FOREIGN KEY (monitor_id, org_id) REFERENCES monitors (id, org_id) ON DELETE CASCADE
);
CREATE INDEX alert_jobs_due_idx ON alert_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX alert_jobs_org_idx ON alert_jobs (org_id, created_at DESC);
