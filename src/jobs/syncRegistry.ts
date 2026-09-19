/**
 * Syncs the CHPL registry into Postgres.
 *
 * CHPL is the seed: it tells us which vendors carry the 170.404 obligations and
 * where their published documentation lives. The sync pulls the full result set
 * for the API criteria, then narrows to the vendors we are actually pursuing.
 *
 * Scope is ours, not CHPL's. The sync never un-scopes a vendor we chose -- see
 * the in_scope handling in upsertVendor.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { searchListings, collapseToVendors, owesApiAccess } from '../lib/chpl.ts';
import { upsertVendor, db } from '../db/client.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface SeedVendor {
  name: string;
  chplDeveloperId: string | null;
  segment: string | null;
  website: string | null;
  developerPortalUrl: string | null;
  apiDocumentationUrl: string | null;
  termsUrl: string | null;
  contactEmail: string | null;
  inScope: boolean;
}

function loadSeed(): SeedVendor[] {
  const raw = readFileSync(join(here, '..', 'db', 'seed-vendors.json'), 'utf8');
  return (JSON.parse(raw).vendors ?? []) as SeedVendor[];
}

/**
 * Match a CHPL developer name to a seed entry.
 *
 * Vendor names in CHPL carry legal suffixes the marketing name does not
 * ("athenahealth, Inc."), so exact equality misses. We normalize and compare on
 * containment in either direction, which is loose enough to match reliably and
 * tight enough that the three names in our seed do not collide.
 */
function normalizeName(n: string): string {
  return n
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|holdings|technologies|systems)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesSeed(chplName: string, seedName: string): boolean {
  const a = normalizeName(chplName);
  const b = normalizeName(seedName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export interface SyncResult {
  listingsSeen: number;
  vendorsSeen: number;
  inScopeMatched: { seed: string; chpl: string; developerId: string }[];
  unmatchedSeeds: string[];
}

export async function syncRegistry(): Promise<SyncResult> {
  const runStart = await db().query<{ id: number }>(
    `INSERT INTO sync_runs (kind) VALUES ('chpl') RETURNING id`,
  );
  const runRow = runStart.rows[0];
  if (!runRow) throw new Error('Could not open a sync_runs row.');
  const runId = runRow.id;

  try {
    const listings = await searchListings();
    const vendors = collapseToVendors(listings).filter(owesApiAccess);
    const seed = loadSeed().filter((s) => s.inScope);

    const matched: SyncResult['inScopeMatched'] = [];
    const matchedSeedNames = new Set<string>();

    for (const v of vendors) {
      const seedHit = seed.find((s) => matchesSeed(v.name, s.name));
      if (seedHit) {
        matchedSeedNames.add(seedHit.name);
        matched.push({ seed: seedHit.name, chpl: v.name, developerId: v.chplDeveloperId });
      }

      await upsertVendor({
        chplDeveloperId: v.chplDeveloperId,
        name: v.name,
        website: v.website,
        certifiedCriteria: v.certifiedCriteria,
        chplStatus: v.chplStatus,
        apiDocumentationUrl: v.apiDocumentationUrl,
        serviceBaseUrlList: v.serviceBaseUrlList,
        termsUrl: v.termsUrl,
        // Seed values fill gaps CHPL does not cover; CHPL wins where both exist.
        segment: seedHit?.segment ?? null,
        developerPortalUrl: seedHit?.developerPortalUrl ?? null,
        contactEmail: seedHit?.contactEmail ?? null,
        inScope: Boolean(seedHit),
      });
    }

    const unmatched = seed.map((s) => s.name).filter((n) => !matchedSeedNames.has(n));

    await db().query(
      `UPDATE sync_runs SET finished_at = now(), vendors_seen = $2, ok = TRUE WHERE id = $1`,
      [runId, vendors.length],
    );

    return {
      listingsSeen: listings.length,
      vendorsSeen: vendors.length,
      inScopeMatched: matched,
      unmatchedSeeds: unmatched,
    };
  } catch (err) {
    await db().query(
      `UPDATE sync_runs SET finished_at = now(), ok = FALSE, error = $2 WHERE id = $1`,
      [runId, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncRegistry()
    .then((r) => {
      console.log(`Listings: ${r.listingsSeen}  Vendors owing API access: ${r.vendorsSeen}`);
      for (const m of r.inScopeMatched) {
        console.log(`  matched  ${m.seed} -> "${m.chpl}" (developer ${m.developerId})`);
      }
      for (const u of r.unmatchedSeeds) {
        console.log(`  NO MATCH ${u} — not found among g10-certified developers. ` +
                    `Either the name differs in CHPL or they are not certified.`);
      }
      process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
