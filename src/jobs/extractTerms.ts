/**
 * Extracts each in-scope vendor's published terms into requirement_fields.
 *
 * For each vendor: gather the pages we know about (the seed's sourceUrls
 * plus whatever CHPL and the seed gave us for portal, terms, and docs), run
 * the extraction pass, verify every snippet against the fetched text, diff
 * the survivors against what we already hold, and save. Rejected candidates
 * are printed, never stored.
 *
 *   npm run extract                       all in-scope vendors, write to DB
 *   npm run extract -- --vendor "Canvas Medical"
 *   npm run extract -- --dry-run          no database; seed URLs only; print
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Non-dry runs
 * need DATABASE_URL and a registry that has been synced, so the vendor rows
 * exist to attach fields to.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gatherSources, type SourcePage } from '../lib/terms.ts';
import { extractFromPages, type Rejection } from '../lib/extractor.ts';
import { diffExtraction, type ExtractedField, type FieldChange } from '../lib/extract.ts';
import { matchesSeed } from './syncRegistry.ts';
import { db, listVendors, currentFields, saveFields } from '../db/client.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface SeedVendor {
  name: string;
  inScope: boolean;
  developerPortalUrl: string | null;
  apiDocumentationUrl: string | null;
  termsUrl: string | null;
  sourceUrls?: string[];
}

function loadSeed(): SeedVendor[] {
  const raw = readFileSync(join(here, '..', 'db', 'seed-vendors.json'), 'utf8');
  return (JSON.parse(raw).vendors ?? []) as SeedVendor[];
}

export interface VendorExtraction {
  vendor: string;
  pages: { url: string; retrievedAt: string; chars: number }[];
  fetchFailures: { url: string; error: string }[];
  accepted: ExtractedField[];
  rejected: Rejection[];
  changes: FieldChange[];
  notes: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** The URLs to read for a vendor: explicit seed sources first, then links. */
function sourceUrlsFor(seed: SeedVendor | undefined, row?: {
  developer_portal_url: string | null; terms_url: string | null; api_documentation_url: string | null;
}): string[] {
  const urls = [
    ...(seed?.sourceUrls ?? []),
    seed?.developerPortalUrl, seed?.termsUrl, seed?.apiDocumentationUrl,
    row?.developer_portal_url, row?.terms_url, row?.api_documentation_url,
  ];
  return [...new Set(urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))];
}

async function runOne(
  name: string,
  urls: string[],
  previous: Map<ExtractedField['field'], { value: string | null; hash: string }>,
): Promise<VendorExtraction> {
  const { pages, failures } = await gatherSources(urls);
  if (pages.length === 0) {
    throw new Error(`${name}: none of ${urls.length} source URLs could be fetched.`);
  }
  const result = await extractFromPages(name, pages);
  return {
    vendor: name,
    pages: pages.map((p: SourcePage) => ({ url: p.url, retrievedAt: p.retrievedAt, chars: p.text.length })),
    fetchFailures: failures,
    accepted: result.accepted,
    rejected: result.rejected,
    changes: diffExtraction(previous, result.accepted),
    notes: result.notes,
    usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
  };
}

export async function extractTerms(opts: { vendor?: string; dryRun?: boolean } = {}): Promise<VendorExtraction[]> {
  const seed = loadSeed().filter((s) => s.inScope);
  const wanted = (n: string) => !opts.vendor || matchesSeed(n, opts.vendor);
  const out: VendorExtraction[] = [];

  if (opts.dryRun) {
    for (const s of seed.filter((v) => wanted(v.name))) {
      out.push(await runOne(s.name, sourceUrlsFor(s), new Map()));
    }
    return out;
  }

  const runStart = await db().query<{ id: number }>(
    `INSERT INTO sync_runs (kind) VALUES ('terms') RETURNING id`,
  );
  const runRow = runStart.rows[0];
  if (!runRow) throw new Error('Could not open a sync_runs row.');

  try {
    const vendors = (await listVendors(true)).filter((v) => wanted(v.name));
    if (vendors.length === 0) {
      throw new Error(
        opts.vendor
          ? `No in-scope vendor matches "${opts.vendor}". Has the registry been synced?`
          : 'No in-scope vendors in the registry. Run `npm run sync` first.',
      );
    }
    let changesFound = 0;
    for (const v of vendors) {
      const s = seed.find((x) => matchesSeed(v.name, x.name));
      const r = await runOne(v.name, sourceUrlsFor(s, v), await currentFields(v.id));
      await saveFields(v.id, r.accepted, r.changes);
      changesFound += r.changes.length;
      out.push(r);
    }
    await db().query(
      `UPDATE sync_runs SET finished_at = now(), vendors_seen = $2, changes_found = $3, ok = TRUE WHERE id = $1`,
      [runRow.id, vendors.length, changesFound],
    );
    return out;
  } catch (err) {
    await db().query(
      `UPDATE sync_runs SET finished_at = now(), ok = FALSE, error = $2 WHERE id = $1`,
      [runRow.id, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  } finally {
    await db().end();
  }
}

function report(r: VendorExtraction): void {
  console.log(`\n== ${r.vendor} ==`);
  for (const p of r.pages) console.log(`  read     ${p.url} (${p.chars} chars, ${p.retrievedAt})`);
  for (const f of r.fetchFailures) console.log(`  FAILED   ${f.url}: ${f.error}`);
  console.log(`  tokens   in ${r.usage.input_tokens}  out ${r.usage.output_tokens}`);
  for (const f of r.accepted) {
    const tag = f.value === null ? 'absent ' : f.confidence >= 0.75 ? 'ok     ' : 'LOW    ';
    console.log(`  ${tag}  ${f.field} (${f.confidence.toFixed(2)}): ${f.value ?? '— vendor does not state'}`);
    if (f.snippet) console.log(`           > ${f.snippet.slice(0, 160)}${f.snippet.length > 160 ? '…' : ''}`);
  }
  for (const x of r.rejected) {
    console.log(`  REJECT   ${x.candidate.field}: ${x.reason}`);
  }
  for (const c of r.changes) {
    console.log(`  ${c.material ? 'MATERIAL' : 'change  '} ${c.field}: ${JSON.stringify(c.oldValue)} -> ${JSON.stringify(c.newValue)}`);
  }
  if (r.notes) console.log(`  notes    ${r.notes}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const vendorIdx = args.indexOf('--vendor');
  const vendor = vendorIdx >= 0 ? args[vendorIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  extractTerms({ vendor, dryRun })
    .then((results) => {
      if (json) console.log(JSON.stringify(results, null, 2));
      else for (const r of results) report(r);
      const rejected = results.reduce((n, r) => n + r.rejected.length, 0);
      const accepted = results.reduce((n, r) => n + r.accepted.length, 0);
      console.log(`\n${accepted} fields accepted, ${rejected} rejected${dryRun ? ' (dry run; nothing saved)' : ''}.`);
      process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
