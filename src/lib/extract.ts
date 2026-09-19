/**
 * Vendor requirements: the field vocabulary, the provenance rules, and change
 * detection.
 *
 * Vendors are obligated under 45 CFR 170.404(a)(2) to publish their terms,
 * fees, and registration requirements. This module turns those published pages
 * into a comparable, attributable record.
 *
 * The central constraint: we ACT on these fields. A packet is built from them,
 * and a complaint to ONC may be escalated on the strength of the dates they
 * imply. So a field is only usable if it carries the URL it came from, when we
 * fetched it, a confidence, and the verbatim sentence that supports it. There
 * is deliberately no way to record a value without that evidence -- see
 * `ExtractedField`, where all four are required.
 */

import { createHash } from 'node:crypto';

/**
 * The fixed field vocabulary. Fixed so that vendors stay comparable: two
 * vendors' registration processes differ wildly in prose but answer the same
 * questions.
 */
export const FIELDS = {
  registration_url: 'Where an API User submits a registration request',
  registration_process: 'What the vendor requires to register an application',
  authenticity_verification: 'The vendor\'s stated identity/authenticity verification process',
  sandbox_availability: 'Whether a sandbox or test environment is available, and how to get it',
  sandbox_cost: 'Any cost attached to sandbox access',
  production_process: 'What the vendor requires to move from sandbox to production',
  auth_flow: 'Authorization flow(s) supported (SMART on FHIR, client credentials, etc.)',
  supported_scopes: 'Scopes or resources exposed',
  fhir_version: 'FHIR version supported',
  service_base_url: 'Published service base URL or endpoint directory',
  fees: 'Fees disclosed for access, certification, or ongoing use',
  prohibited_conditions: 'Any non-compete, exclusivity, or revenue-share condition attached to access',
  attestations_required: 'Attestations, questionnaires, or certifications the vendor requires',
  baa_required: 'Whether the vendor requires a BAA and on what terms',
  developer_contact: 'Published contact for developer/API access requests',
  terms_last_updated: 'Date the vendor last updated the published terms',
} as const;

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

/**
 * A field value with its evidence. All provenance is required -- an extraction
 * that cannot be traced to a source sentence is not evidence, and the type
 * system is where that rule is cheapest to enforce.
 */
export interface ExtractedField {
  field: FieldName;
  /** Null means: we looked at the source and the vendor does not state this. */
  value: string | null;
  sourceUrl: string;
  retrievedAt: string; // ISO 8601
  /** 0.0-1.0. See CONFIDENCE_THRESHOLD for what is usable unreviewed. */
  confidence: number;
  /** The verbatim sentence(s) supporting the value. Never a paraphrase. */
  snippet: string;
}

/**
 * Below this, a field is not asserted in a packet. It is surfaced as an open
 * item for a human to confirm against the source instead.
 *
 * 0.75 is deliberately cautious. The cost of a wrong assertion in a vendor
 * submission (or worse, in a complaint) is far higher than the cost of a human
 * spending a minute reading one sentence.
 */
export const CONFIDENCE_THRESHOLD = 0.75;

export function isUsable(f: ExtractedField): boolean {
  return f.confidence >= CONFIDENCE_THRESHOLD && f.snippet.trim().length > 0;
}

/**
 * Normalize a value before hashing so that cosmetic edits -- reflowed
 * whitespace, a changed heading -- do not masquerade as substantive changes.
 * Case is preserved: "no fee" and "No fee" are the same, but we would rather
 * over-report than miss a real edit, so only whitespace is collapsed.
 */
export function normalizeValue(value: string | null): string {
  if (value === null) return '\u0000null';
  return value.replace(/\s+/g, ' ').trim();
}

export function hashValue(value: string | null): string {
  return createHash('sha256').update(normalizeValue(value)).digest('hex').slice(0, 16);
}

export interface FieldChange {
  field: FieldName;
  oldValue: string | null;
  newValue: string | null;
  oldHash: string | null;
  newHash: string;
  sourceUrl: string;
  /**
   * Whether this change is one we should look at urgently. A newly appeared
   * fee or prohibited condition is the case this system exists to catch.
   */
  material: boolean;
}

/** Fields where any change deserves immediate human attention. */
const MATERIAL_FIELDS: ReadonlySet<FieldName> = new Set([
  'fees',
  'prohibited_conditions',
  'attestations_required',
  'registration_process',
  'production_process',
  'baa_required',
]);

/**
 * Diff a fresh extraction against what we already hold.
 *
 * Returns only fields that actually changed. A field that disappears from the
 * new extraction is NOT reported as a change -- absence more often means the
 * fetch failed or the page moved than that the vendor deleted a requirement,
 * and treating it as a deletion would quietly erase a real requirement from
 * the packet. Disappearances surface through sync_runs instead.
 */
export function diffExtraction(
  previous: Map<FieldName, { value: string | null; hash: string }>,
  next: ExtractedField[],
): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const f of next) {
    const newHash = hashValue(f.value);
    const prev = previous.get(f.field);

    if (!prev) {
      // Newly observed. A field appearing for the first time is a change worth
      // seeing -- especially a fee that was not there before.
      changes.push({
        field: f.field,
        oldValue: null,
        newValue: f.value,
        oldHash: null,
        newHash,
        sourceUrl: f.sourceUrl,
        material: MATERIAL_FIELDS.has(f.field) && f.value !== null,
      });
      continue;
    }

    if (prev.hash !== newHash) {
      changes.push({
        field: f.field,
        oldValue: prev.value,
        newValue: f.value,
        oldHash: prev.hash,
        newHash,
        sourceUrl: f.sourceUrl,
        material: MATERIAL_FIELDS.has(f.field),
      });
    }
  }

  return changes;
}

// --- Compliance checks on what we extracted --------------------------------

export interface ComplianceFlag {
  severity: 'concern' | 'violation';
  citation: string;
  summary: string;
  field: FieldName;
  evidence: string;
}

/**
 * Check extracted terms against what 170.404 actually permits.
 *
 * These are heuristics over vendor prose, so they are flags for a human, never
 * conclusions. A "violation" here means "this looks like it contradicts the
 * regulation, go read the snippet" -- not "we have established non-compliance."
 */
/**
 * Whether a fees value is a vendor stating it charges nothing.
 *
 * Without this, "No fees are charged for API access" trips the fee heuristic
 * on the word "fee" and we flag the most compliant vendors hardest -- noise
 * that trains the reader to ignore the flags that matter.
 */
function statesNoFee(value: string): boolean {
  const v = value.toLowerCase().trim();
  return /^(?:there\s+(?:are|is)\s+)?no\b[^.]*\b(?:fee|charge|cost)/.test(v)
    || /\b(?:no|zero|without)\s+(?:additional\s+|extra\s+)?(?:fee|charge|cost)s?\b/.test(v)
    || /\b(?:free\s+of\s+charge|at\s+no\s+cost|no\s+charge)\b/.test(v);
}

export function checkCompliance(fields: ExtractedField[]): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  const byName = new Map(fields.map((f) => [f.field, f]));

  const prohibited = byName.get('prohibited_conditions');
  if (prohibited?.value) {
    // Match on the substance, not one spelling. The prohibited conditions in
    // 170.404(a)(4) are routinely phrased as obligations rather than nouns --
    // "Partner agrees not to compete" never contains the string "non-compete"
    // -- so each pattern covers both the noun and the undertaking.
    const v = `${prohibited.value} ${prohibited.snippet}`.toLowerCase();
    const hits = [
      ['a non-compete', /non-?compet|(?:not|refrain from|shall not|agrees? not)\s+to\s+compet|restrict\w*\s+from\s+compet/],
      ['exclusivity', /exclusiv|deal\s+exclusively|sole(?:ly)?\s+with/],
      ['a revenue share or royalty', /revenue[-\s]?shar|royalt|percentage\s+of\s+(?:revenue|sales)/],
    ] as const;
    for (const [label, re] of hits) {
      if (re.test(v)) {
        flags.push({
          severity: 'violation',
          citation: '45 CFR 170.404(a)(4)',
          summary: `Terms appear to condition access on ${label}, which the openness and pro-competitiveness condition prohibits.`,
          field: 'prohibited_conditions',
          evidence: prohibited.snippet,
        });
      }
    }
  }

  const fees = byName.get('fees');
  if (fees?.value && !statesNoFee(fees.value)) {
    const v = fees.value.toLowerCase();
    // 170.404(a)(3) forbids charging for documentation, or for anything
    // essential to developing and distributing production-ready apps.
    if (/document|api reference|specification/.test(v) && /fee|charge|\$|cost/.test(v)) {
      flags.push({
        severity: 'violation',
        citation: '45 CFR 170.404(a)(3)',
        summary:
          'Terms appear to attach a fee to documentation access. Fees for required documentation are prohibited.',
        field: 'fees',
        evidence: fees.snippet,
      });
    } else if (/fee|charge|\$/.test(v)) {
      flags.push({
        severity: 'concern',
        citation: '45 CFR 170.404(a)(3)',
        summary:
          'A fee is disclosed. Permitted only if it is not for anything essential to developing and commercially distributing production-ready applications -- confirm which side of that line it falls on.',
        field: 'fees',
        evidence: fees.snippet,
      });
    }
  }

  // Under (a)(2) the vendor must publish enough to develop against the API.
  // A missing registration path is itself a transparency problem.
  const reg = byName.get('registration_url');
  if (!reg || reg.value === null) {
    flags.push({
      severity: 'concern',
      citation: '45 CFR 170.404(a)(2)',
      summary:
        'No published registration path found. Vendors must publish the registration process requirements needed to deploy applications in production.',
      field: 'registration_url',
      evidence: reg?.snippet ?? '(no source located)',
    });
  }

  return flags;
}
