-- EHR Integration Management System
-- Postgres schema.
--
-- Design note on provenance: every requirement field we extract from a
-- vendor's published terms is stored alongside the URL it came from, when we
-- fetched it, how confident the extraction was, and the verbatim snippet that
-- supports it. We act on these fields -- we build submission packets from them
-- and may escalate to ONC based on the dates they imply -- so an extraction
-- that cannot be traced back to a source sentence is not evidence. The
-- requirement_fields table exists to make that traceability structural rather
-- than a convention someone has to remember.

CREATE TABLE IF NOT EXISTS vendors (
  id                    BIGSERIAL PRIMARY KEY,
  -- CHPL's own developer id. Stable across listings, so it is our join key
  -- back to the government registry.
  chpl_developer_id     TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  website               TEXT,
  -- Criteria the vendor holds, e.g. {'170.315 (g)(10)'}. Presence of g10 is
  -- what makes 170.404 apply to them.
  certified_criteria    TEXT[] NOT NULL DEFAULT '{}',
  -- Our own segmentation, for targeting: ambulatory, behavioral health, etc.
  segment               TEXT,
  -- Whether the developer is currently banned or decertified by ONC. Either
  -- means we should not be spending effort on them.
  chpl_status           TEXT,
  developer_portal_url  TEXT,
  terms_url             TEXT,
  api_documentation_url TEXT,
  service_base_url_list TEXT,
  contact_email         TEXT,
  -- Whether this vendor is in the active working set. The sync pulls the full
  -- CHPL result set; this flag is what narrows it to the vendors we are
  -- actually pursuing.
  in_scope              BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendors_in_scope_idx ON vendors (in_scope) WHERE in_scope;

-- One row per (vendor, field) pair. Fields are a fixed vocabulary so vendors
-- stay comparable; see src/lib/extract.ts for the list and what each means.
CREATE TABLE IF NOT EXISTS requirement_fields (
  id                BIGSERIAL PRIMARY KEY,
  vendor_id         BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  field             TEXT NOT NULL,
  value             TEXT,
  -- Provenance. All four are required for a field to be usable in a packet.
  source_url        TEXT NOT NULL,
  retrieved_at      TIMESTAMPTZ NOT NULL,
  -- 0.0-1.0. The packet generator refuses to assert a field below the
  -- confidence threshold and flags it for human review instead.
  confidence        NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- The verbatim sentence(s) from the source that support this value. Not a
  -- paraphrase -- if we cannot quote it, we did not find it.
  snippet           TEXT NOT NULL,
  -- Hash of the normalized value, used to detect changes between syncs
  -- without diffing free text.
  value_hash        TEXT NOT NULL,
  -- Set once a human has eyeballed the extraction.
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, field)
);

CREATE INDEX IF NOT EXISTS requirement_fields_vendor_idx ON requirement_fields (vendor_id);

-- Append-only history of every value a field has held. This is what makes
-- "the vendor quietly added a fee" a detectable event rather than a thing we
-- notice by accident.
CREATE TABLE IF NOT EXISTS requirement_field_history (
  id            BIGSERIAL PRIMARY KEY,
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  old_hash      TEXT,
  new_hash      TEXT,
  source_url    TEXT NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when a human has looked at the diff and decided what it means.
  acknowledged  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS requirement_field_history_unack_idx
  ON requirement_field_history (vendor_id, detected_at DESC)
  WHERE NOT acknowledged;

-- One row per access request we have made to a vendor. This is the table the
-- regulatory clocks run against, and the one mirrored into Notion.
CREATE TABLE IF NOT EXISTS access_requests (
  id                      BIGSERIAL PRIMARY KEY,
  vendor_id               BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,

  -- The dates that drive everything. request_sent is the date the vendor
  -- RECEIVED our registration request, which is what 170.404(b)(1)(i) keys
  -- off -- not the date we drafted the packet.
  request_sent            DATE,
  verification_completed  DATE,
  production_enabled      DATE,

  -- Computed from the dates above by src/lib/businessDays.ts and refreshed by
  -- the daily clock job. Stored rather than computed on read so that the
  -- Notion mirror and any complaint draft agree on the same numbers.
  verification_due        DATE,
  production_due          DATE,
  clock_status            TEXT,
  business_days_remaining INTEGER,

  -- Set when a deadline passed unmet, or when a vendor imposed a condition
  -- that 170.404(a)(4) prohibits (non-compete, exclusivity, revenue share) or
  -- charged a fee 170.404(a)(3) forbids.
  blocking_concern        BOOLEAN NOT NULL DEFAULT FALSE,
  blocking_note           TEXT,

  packet_url              TEXT,
  notion_page_id          TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_requests_vendor_idx ON access_requests (vendor_id);
CREATE INDEX IF NOT EXISTS access_requests_open_idx
  ON access_requests (clock_status)
  WHERE production_enabled IS NULL;

-- Log of every CHPL sync and terms re-fetch, so we can say when we last had
-- eyes on a vendor and whether the last look succeeded.
CREATE TABLE IF NOT EXISTS sync_runs (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,  -- 'chpl' | 'terms'
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  vendors_seen   INTEGER,
  changes_found  INTEGER,
  ok             BOOLEAN,
  error          TEXT
);
