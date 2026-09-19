/**
 * Postgres connection and the queries the jobs and server share.
 */

import { Pool, types as pgTypes } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FieldName, ExtractedField, FieldChange } from '../lib/extract.ts';
import { hashValue } from '../lib/extract.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Return DATE columns as plain YYYY-MM-DD strings.
//
// By default node-postgres parses a DATE into a JavaScript Date at LOCAL
// midnight. Converting that back with toISOString() shifts the calendar day
// whenever the server's offset is positive -- so a deadline stored as
// 2026-09-15 comes back as 2026-09-14 on a UTC+ host. These dates decide
// whether a vendor has missed a statutory deadline, so a silent one-day shift
// driven by server timezone is not survivable. DATE is a calendar date with no
// time or zone; keeping it a string is the only faithful representation.
pgTypes.setTypeParser(pgTypes.builtins.DATE, (v: string) => v);

// Return BIGSERIAL ids as numbers rather than strings.
//
// node-postgres returns int8 as a string because int8 can exceed
// Number.MAX_SAFE_INTEGER. Ours are row ids in a registry of a few hundred
// vendors, so that ceiling is not in reach -- but a silent string/number
// mismatch in an id comparison fails as a 404 with no error anywhere, which is
// worse than the precision risk. We convert, and throw loudly in the
// impossible case rather than returning a quietly wrong number.
pgTypes.setTypeParser(pgTypes.builtins.INT8, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${v} exceeds safe integer range; widen the id handling.`);
  }
  return n;
});

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. On Render this is provided automatically when the ' +
          'service is linked to the Postgres instance; locally, copy it from the ' +
          'database\'s Connect panel.',
      );
    }
    pool = new Pool({
      connectionString,
      // Render's managed Postgres terminates TLS with a cert the default chain
      // does not verify. The connection is still encrypted.
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

/** Idempotent. Safe to run on every boot. */
export async function migrate(): Promise<void> {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await db().query(sql);
}

export interface VendorRow {
  id: number;
  chpl_developer_id: string;
  name: string;
  website: string | null;
  certified_criteria: string[];
  segment: string | null;
  chpl_status: string | null;
  developer_portal_url: string | null;
  terms_url: string | null;
  api_documentation_url: string | null;
  service_base_url_list: string | null;
  contact_email: string | null;
  in_scope: boolean;
}

export async function upsertVendor(v: {
  chplDeveloperId: string;
  name: string;
  website?: string | null;
  certifiedCriteria?: string[];
  segment?: string | null;
  chplStatus?: string | null;
  developerPortalUrl?: string | null;
  termsUrl?: string | null;
  apiDocumentationUrl?: string | null;
  serviceBaseUrlList?: string | null;
  contactEmail?: string | null;
  inScope?: boolean;
}): Promise<VendorRow> {
  const { rows } = await db().query<VendorRow>(
    `INSERT INTO vendors (
       chpl_developer_id, name, website, certified_criteria, segment, chpl_status,
       developer_portal_url, terms_url, api_documentation_url, service_base_url_list,
       contact_email, in_scope, last_synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,FALSE),now())
     ON CONFLICT (chpl_developer_id) DO UPDATE SET
       name = EXCLUDED.name,
       website = COALESCE(EXCLUDED.website, vendors.website),
       certified_criteria = EXCLUDED.certified_criteria,
       segment = COALESCE(EXCLUDED.segment, vendors.segment),
       chpl_status = EXCLUDED.chpl_status,
       developer_portal_url = COALESCE(EXCLUDED.developer_portal_url, vendors.developer_portal_url),
       terms_url = COALESCE(EXCLUDED.terms_url, vendors.terms_url),
       api_documentation_url = COALESCE(EXCLUDED.api_documentation_url, vendors.api_documentation_url),
       service_base_url_list = COALESCE(EXCLUDED.service_base_url_list, vendors.service_base_url_list),
       contact_email = COALESCE(EXCLUDED.contact_email, vendors.contact_email),
       -- in_scope is ours, not CHPL's: never let a sync un-scope a vendor we chose.
       in_scope = vendors.in_scope OR COALESCE(EXCLUDED.in_scope, FALSE),
       last_synced_at = now()
     RETURNING *`,
    [
      v.chplDeveloperId, v.name, v.website ?? null, v.certifiedCriteria ?? [],
      v.segment ?? null, v.chplStatus ?? null, v.developerPortalUrl ?? null,
      v.termsUrl ?? null, v.apiDocumentationUrl ?? null, v.serviceBaseUrlList ?? null,
      v.contactEmail ?? null, v.inScope ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error(`upsertVendor returned no row for ${v.chplDeveloperId}`);
  return row;
}

export async function listVendors(onlyInScope = true): Promise<VendorRow[]> {
  const { rows } = await db().query<VendorRow>(
    `SELECT * FROM vendors ${onlyInScope ? 'WHERE in_scope' : ''} ORDER BY name`,
  );
  return rows;
}

export async function currentFields(
  vendorId: number,
): Promise<Map<FieldName, { value: string | null; hash: string }>> {
  const { rows } = await db().query<{ field: FieldName; value: string | null; value_hash: string }>(
    'SELECT field, value, value_hash FROM requirement_fields WHERE vendor_id = $1',
    [vendorId],
  );
  return new Map(rows.map((r) => [r.field, { value: r.value, hash: r.value_hash }]));
}

export async function loadFields(vendorId: number): Promise<ExtractedField[]> {
  const { rows } = await db().query(
    `SELECT field, value, source_url, retrieved_at, confidence, snippet
       FROM requirement_fields WHERE vendor_id = $1`,
    [vendorId],
  );
  return rows.map((r) => ({
    field: r.field as FieldName,
    value: r.value,
    sourceUrl: r.source_url,
    retrievedAt: new Date(r.retrieved_at).toISOString(),
    confidence: Number(r.confidence),
    snippet: r.snippet,
  }));
}

/** Write an extraction and record any change against what we held before. */
export async function saveFields(
  vendorId: number,
  fields: ExtractedField[],
  changes: FieldChange[],
): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    for (const f of fields) {
      await client.query(
        `INSERT INTO requirement_fields
           (vendor_id, field, value, source_url, retrieved_at, confidence, snippet, value_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (vendor_id, field) DO UPDATE SET
           value = EXCLUDED.value, source_url = EXCLUDED.source_url,
           retrieved_at = EXCLUDED.retrieved_at, confidence = EXCLUDED.confidence,
           snippet = EXCLUDED.snippet, value_hash = EXCLUDED.value_hash,
           -- A changed value invalidates any prior human review.
           reviewed_by = CASE WHEN requirement_fields.value_hash = EXCLUDED.value_hash
                              THEN requirement_fields.reviewed_by ELSE NULL END,
           reviewed_at = CASE WHEN requirement_fields.value_hash = EXCLUDED.value_hash
                              THEN requirement_fields.reviewed_at ELSE NULL END`,
        [vendorId, f.field, f.value, f.sourceUrl, f.retrievedAt, f.confidence, f.snippet, hashValue(f.value)],
      );
    }
    for (const c of changes) {
      await client.query(
        `INSERT INTO requirement_field_history
           (vendor_id, field, old_value, new_value, old_hash, new_hash, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [vendorId, c.field, c.oldValue, c.newValue, c.oldHash, c.newHash, c.sourceUrl],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface RequestRow {
  id: number;
  vendor_id: number;
  vendor_name?: string;
  request_sent: string | null;
  verification_completed: string | null;
  production_enabled: string | null;
  verification_due: string | null;
  production_due: string | null;
  clock_status: string | null;
  business_days_remaining: number | null;
  blocking_concern: boolean;
  blocking_note: string | null;
  packet_url: string | null;
  notion_page_id: string | null;
  notes: string | null;
}

export async function listRequests(): Promise<RequestRow[]> {
  const { rows } = await db().query<RequestRow>(
    `SELECT r.*, v.name AS vendor_name
       FROM access_requests r JOIN vendors v ON v.id = r.vendor_id
      ORDER BY v.name`,
  );
  return rows;
}

export async function updateClock(
  id: number,
  c: {
    verificationDue: string | null;
    productionDue: string | null;
    clockStatus: string;
    businessDaysRemaining: number | null;
    blockingConcern: boolean;
    blockingNote: string | null;
  },
): Promise<void> {
  await db().query(
    `UPDATE access_requests SET
       verification_due = $2, production_due = $3, clock_status = $4,
       business_days_remaining = $5,
       -- Never clear a concern a human set by hand; only ever raise one.
       blocking_concern = access_requests.blocking_concern OR $6,
       blocking_note = COALESCE($7, access_requests.blocking_note),
       updated_at = now()
     WHERE id = $1`,
    [id, c.verificationDue, c.productionDue, c.clockStatus, c.businessDaysRemaining,
     c.blockingConcern, c.blockingNote],
  );
}
