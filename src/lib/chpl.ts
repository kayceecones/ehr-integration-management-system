/**
 * Client for the ONC Certified Health IT Product List (CHPL) Open API.
 *
 * CHPL is the authoritative public registry of certified health IT. It is the
 * seed for this whole system: filtering it to products certified under
 * 170.315(g)(10) yields exactly the set of vendors that 45 CFR 170.404
 * obligates to give us API access, and each listing carries links to the
 * vendor's published API documentation and mandatory disclosures -- the terms
 * the extractor then reads.
 *
 * Auth: a free read-only API key, requested at chpl.healthit.gov and confirmed
 * by email. Sent as an `API-Key` header.
 *
 * Docs: https://chpl.healthit.gov/rest/v3/api-docs
 */

const BASE_URL = process.env.CHPL_BASE_URL ?? 'https://chpl.healthit.gov/rest';

/**
 * The certification criterion that carries the API access obligation.
 * (g)(31) and (g)(33) are the newer companion criteria; 170.404(b)(1) applies
 * to modules certified to any of them.
 */
export const API_CRITERIA = ['170.315 (g)(10)', '170.315 (g)(31)', '170.315 (g)(33)'];

export interface ChplCriterion {
  id: number;
  number: string;
  title?: string;
}

export interface ChplListing {
  id: number;
  chplProductNumber: string;
  developer: { id: number; name: string; website?: string | null };
  product: { id: number; name: string };
  version?: { id: number; name: string } | null;
  certificationStatus?: string;
  certificationDate?: number | string;
  criteriaMet?: string[];
  apiDocumentation?: string | null;
  serviceBaseUrlList?: string | null;
  mandatoryDisclosures?: string | null;
}

export interface ChplSearchResponse {
  recordCount: number;
  pageNumber: number;
  pageSize: number;
  results: ChplListing[];
}

export class ChplError extends Error {
  // Declared as plain fields rather than constructor parameter properties:
  // parameter properties need a full TypeScript compile and break under
  // Node's type-stripping, which the jobs use.
  status?: number;
  body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ChplError';
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.CHPL_API_KEY;
  if (!key) {
    throw new ChplError(
      'CHPL_API_KEY is not set. Request a free key at https://chpl.healthit.gov ' +
        '(Resources -> CHPL API), confirm it by email, and set it as an environment variable.',
    );
  }
  return key;
}

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: { 'API-Key': apiKey(), Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ChplError(
      `CHPL ${res.status} ${res.statusText} for ${url.pathname}`,
      res.status,
      body.slice(0, 500),
    );
  }
  return (await res.json()) as T;
}

/** The full criteria vocabulary, used to resolve criterion numbers to ids. */
export async function listCriteria(): Promise<ChplCriterion[]> {
  return get<ChplCriterion[]>('/certification-criteria');
}

/**
 * Resolve criterion numbers (e.g. "170.315 (g)(10)") to the numeric ids the
 * search endpoint expects. CHPL reissues criteria across editions, so a single
 * number can map to more than one id; we keep all of them.
 */
export async function criterionIds(numbers: string[] = API_CRITERIA): Promise<number[]> {
  const all = await listCriteria();
  const wanted = new Set(numbers.map((n) => n.replace(/\s+/g, '')));
  return all.filter((c) => wanted.has(c.number.replace(/\s+/g, ''))).map((c) => c.id);
}

export interface SearchOptions {
  criteriaIds?: number[];
  /** Defaults to Active only -- a retired listing carries no live obligation. */
  certificationStatuses?: string[];
  pageSize?: number;
  maxPages?: number;
}

/**
 * Page through every listing matching the given criteria.
 *
 * CHPL caps page size at 100. We stop at maxPages as a guard so a bad filter
 * cannot walk the entire registry unattended.
 */
export async function searchListings(opts: SearchOptions = {}): Promise<ChplListing[]> {
  const ids = opts.criteriaIds ?? (await criterionIds());
  if (ids.length === 0) {
    throw new ChplError('No matching certification criteria found in CHPL -- check API_CRITERIA.');
  }

  const pageSize = Math.min(opts.pageSize ?? 100, 100);
  const maxPages = opts.maxPages ?? 25;
  const statuses = opts.certificationStatuses ?? ['Active'];

  const out: ChplListing[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await get<ChplSearchResponse>('/search/v3', {
      certificationCriteriaIds: ids.join(','),
      certificationCriteriaOperator: 'OR',
      certificationStatuses: statuses.join(','),
      pageNumber: page,
      pageSize,
    });
    out.push(...res.results);
    if (out.length >= res.recordCount || res.results.length === 0) break;
  }
  return out;
}

export interface VendorRecord {
  chplDeveloperId: string;
  name: string;
  website: string | null;
  certifiedCriteria: string[];
  chplStatus: string | null;
  apiDocumentationUrl: string | null;
  serviceBaseUrlList: string | null;
  termsUrl: string | null;
  productNames: string[];
}

/**
 * Collapse listings to one record per developer.
 *
 * A vendor may have many certified products; the API access obligation and the
 * registration process sit with the developer, not the product, so that is the
 * grain we track. Criteria and doc links are unioned across their listings.
 */
export function collapseToVendors(listings: ChplListing[]): VendorRecord[] {
  const byDeveloper = new Map<string, VendorRecord>();

  for (const l of listings) {
    const id = String(l.developer.id);
    let rec = byDeveloper.get(id);
    if (!rec) {
      rec = {
        chplDeveloperId: id,
        name: l.developer.name,
        website: l.developer.website ?? null,
        certifiedCriteria: [],
        chplStatus: l.certificationStatus ?? null,
        apiDocumentationUrl: null,
        serviceBaseUrlList: null,
        termsUrl: null,
        productNames: [],
      };
      byDeveloper.set(id, rec);
    }

    for (const c of l.criteriaMet ?? []) {
      if (!rec.certifiedCriteria.includes(c)) rec.certifiedCriteria.push(c);
    }
    if (!rec.productNames.includes(l.product.name)) rec.productNames.push(l.product.name);

    // Keep the first non-empty link we see for each. Listings from the same
    // developer normally point at the same documentation.
    rec.apiDocumentationUrl ??= l.apiDocumentation || null;
    rec.serviceBaseUrlList ??= l.serviceBaseUrlList || null;
    rec.termsUrl ??= l.mandatoryDisclosures || null;
  }

  return [...byDeveloper.values()];
}

/** True if the vendor holds any criterion that triggers the 170.404 obligations. */
export function owesApiAccess(vendor: VendorRecord): boolean {
  const held = vendor.certifiedCriteria.map((c) => c.replace(/\s+/g, ''));
  return API_CRITERIA.some((c) => held.includes(c.replace(/\s+/g, '')));
}
