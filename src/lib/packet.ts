/**
 * Submission packet generator.
 *
 * Combines Ruby's canonical profile with one vendor's extracted requirements
 * to produce a Markdown packet for a human to review and send.
 *
 * Two rules govern what comes out of here:
 *
 * 1. Nothing is asserted that is not supported. A requirement extracted below
 *    the confidence threshold, or a profile field still marked
 *    needsConfirmation, becomes an OPEN ITEM in the packet rather than a
 *    confident statement. It is better to hand someone a packet that says
 *    "confirm this" than one that quietly states something false to a vendor.
 *
 * 2. Nothing is sent. This module returns text. A human reads it and submits.
 */

import type { ExtractedField, FieldName, ComplianceFlag } from './extract.ts';
import { isUsable, FIELDS } from './extract.ts';

export interface RubyProfile {
  entity: { legalName: string; type?: string; jurisdiction?: string | null; needsConfirmation?: boolean; confirmationNote?: string };
  contacts: {
    technical: { name: string; email: string };
    business: { name: string; email: string };
    security?: { name: string; email: string };
  };
  web: { website: string; privacyPolicy: string; termsOfService?: string | null; needsConfirmation?: boolean; confirmationNote?: string };
  application: {
    name: string; summary: string; category: string; userType: string;
    accessModel: string; accessModelNote: string; redirectUris: string[];
    needsConfirmation?: boolean; confirmationNote?: string;
  };
  requestedScopes: { resource: string; scope: string; justification: string }[];
  scopePosture: { writeAccess: boolean; writeAccessNote: string; minimumNecessary: string; bulkExport: boolean };
  security: Record<string, unknown> & { statement: string; willSignBaa: boolean; needsConfirmation?: boolean; confirmationNote?: string };
  regulatoryPosture: { citations: Record<string, string>; note: string };
}

export interface VendorContext {
  name: string;
  chplDeveloperId: string;
  certifiedCriteria: string[];
  developerPortalUrl?: string | null;
  termsUrl?: string | null;
  apiDocumentationUrl?: string | null;
  contactEmail?: string | null;
}

export interface Packet {
  vendor: string;
  markdown: string;
  /** Things a human must resolve before this can be sent. */
  openItems: string[];
  /** Regulatory flags raised by this vendor's terms. */
  flags: ComplianceFlag[];
  /** True when nothing blocks sending. */
  readyToSend: boolean;
}

function fieldValue(fields: ExtractedField[], name: FieldName): ExtractedField | undefined {
  return fields.find((f) => f.field === name);
}

/** Render a requirement, or say plainly that we could not establish it. */
function renderRequirement(fields: ExtractedField[], name: FieldName): string {
  const f = fieldValue(fields, name);
  if (!f) return `_Not located in published terms._`;
  if (f.value === null) return `_Vendor does not state this._ (checked ${f.sourceUrl})`;
  if (!isUsable(f)) {
    return `⚠️ _Low-confidence extraction (${f.confidence.toFixed(2)}) — confirm before relying on this._\n\n> ${f.snippet}\n\nSource: ${f.sourceUrl}`;
  }
  return `${f.value}\n\n> ${f.snippet}\n\nSource: ${f.sourceUrl} (retrieved ${f.retrievedAt.slice(0, 10)})`;
}

export function generatePacket(
  profile: RubyProfile,
  vendor: VendorContext,
  fields: ExtractedField[],
  flags: ComplianceFlag[] = [],
): Packet {
  const openItems: string[] = [];

  // Profile fields the operator has not yet confirmed.
  for (const section of ['entity', 'web', 'application', 'security'] as const) {
    const s = profile[section] as { needsConfirmation?: boolean; confirmationNote?: string };
    if (s?.needsConfirmation) {
      openItems.push(`profile.${section}: ${s.confirmationNote ?? 'needs confirmation'}`);
    }
  }

  // Requirements we could not establish well enough to rely on.
  for (const name of Object.keys(FIELDS) as FieldName[]) {
    const f = fieldValue(fields, name);
    if (!f) {
      openItems.push(`${name}: not located in the vendor's published terms — check ${vendor.termsUrl ?? 'their disclosures'} by hand.`);
    } else if (f.value !== null && !isUsable(f)) {
      openItems.push(`${name}: extraction confidence ${f.confidence.toFixed(2)} is below threshold — verify against ${f.sourceUrl}.`);
    }
  }

  for (const flag of flags) {
    if (flag.severity === 'violation') {
      openItems.push(`${flag.citation}: ${flag.summary} Decide how to raise this before submitting.`);
    }
  }

  const scopeTable = profile.requestedScopes
    .map((s) => `| \`${s.scope}\` | ${s.resource} | ${s.justification} |`)
    .join('\n');

  const criteria = vendor.certifiedCriteria.length
    ? vendor.certifiedCriteria.join(', ')
    : '(none recorded)';

  const md = `# API access request — ${vendor.name}

**From:** ${profile.entity.legalName}
**Application:** ${profile.application.name}
**Prepared:** ${new Date().toISOString().slice(0, 10)}
**CHPL developer ID:** ${vendor.chplDeveloperId}

---

## 1. Who is asking

${profile.entity.legalName} operates ${profile.application.name}.

${profile.application.summary}

| | |
| --- | --- |
| Legal entity | ${profile.entity.legalName}${profile.entity.type ? ` (${profile.entity.type})` : ''} |
| Website | ${profile.web.website} |
| Privacy policy | ${profile.web.privacyPolicy} |
| Technical contact | ${profile.contacts.technical.name} — ${profile.contacts.technical.email} |
| Business contact | ${profile.contacts.business.name} — ${profile.contacts.business.email} |
| Application category | ${profile.application.category} |
| User type | ${profile.application.userType} |

## 2. What is being requested

${profile.application.accessModelNote}

**Redirect URI(s):** ${profile.application.redirectUris.map((u) => `\`${u}\``).join(', ')}

### Scopes and why each is needed

| Scope | Resource | Why ${profile.application.name} needs it |
| --- | --- | --- |
${scopeTable}

**Write access:** ${profile.scopePosture.writeAccess ? 'Requested' : 'Not requested'}. ${profile.scopePosture.writeAccessNote}

**Bulk export:** ${profile.scopePosture.bulkExport ? 'Requested' : 'Not requested'}.

**Minimum necessary:** ${profile.scopePosture.minimumNecessary}

## 3. Security and compliance posture

${profile.security.statement}

- **Business Associate Agreement:** ${profile.security.willSignBaa ? 'Ruby Health LLC will execute a BAA.' : 'Not offered.'}
- **Encryption in transit:** ${String(profile.security.encryptionInTransit ?? 'not stated')}
- **Encryption at rest:** ${profile.security.encryptionAtRest ? 'Yes' : 'Not stated'}
- **Audit logging:** ${String(profile.security.auditLogging ?? 'not stated')}

## 4. Basis for the request

${profile.regulatoryPosture.note}

${vendor.name} holds ${criteria}. Under ${profile.regulatoryPosture.citations.accessObligation}, a Certified API Developer completes authenticity verification of an API User within **ten business days** of receiving a registration request (${profile.regulatoryPosture.citations.verificationDeadline}), and registers and enables the application for production use within **five business days** of completing that verification (${profile.regulatoryPosture.citations.productionDeadline}).

Practice authorization is obtained separately, under ${profile.regulatoryPosture.citations.practiceAuthorization}.

## 5. ${vendor.name}'s published requirements, as we read them

Extracted from ${vendor.name}'s published terms and developer documentation. Each item carries the source it came from.

### Registration
${renderRequirement(fields, 'registration_url')}

### Registration process
${renderRequirement(fields, 'registration_process')}

### Authenticity verification
${renderRequirement(fields, 'authenticity_verification')}

### Sandbox
${renderRequirement(fields, 'sandbox_availability')}

### Path to production
${renderRequirement(fields, 'production_process')}

### Authorization flow
${renderRequirement(fields, 'auth_flow')}

### FHIR version
${renderRequirement(fields, 'fhir_version')}

### Attestations required
${renderRequirement(fields, 'attestations_required')}

### BAA
${renderRequirement(fields, 'baa_required')}

### Fees disclosed
${renderRequirement(fields, 'fees')}

### Conditions attached to access
${renderRequirement(fields, 'prohibited_conditions')}

### Developer contact
${renderRequirement(fields, 'developer_contact')}

${flags.length ? `## 6. Regulatory flags\n\n${flags
    .map(
      (f) =>
        `**${f.severity === 'violation' ? '🔴' : '🟡'} ${f.citation}** — ${f.summary}\n\n> ${f.evidence}`,
    )
    .join('\n\n')}\n\nThese are flags for review, not conclusions. Read each snippet against the source before acting on it.\n` : ''}
${openItems.length ? `## ${flags.length ? 7 : 6}. Open items — resolve before sending\n\n${openItems.map((i) => `- [ ] ${i}`).join('\n')}\n` : '## Ready to send\n\nNo open items.\n'}
---

_Generated by the EHR Integration Management System. Nothing here has been sent. Review, resolve open items, then submit through the vendor's published process._
`;

  return {
    vendor: vendor.name,
    markdown: md,
    openItems,
    flags,
    readyToSend: openItems.length === 0,
  };
}
