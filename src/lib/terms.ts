/**
 * Fetching a vendor's published terms and proving a snippet came from them.
 *
 * 170.404(a)(2) obligates vendors to publish their terms; this module fetches
 * those pages, reduces them to plain text, and -- the part that matters --
 * checks whether a quoted snippet actually appears in the fetched text.
 *
 * That check is what makes provenance real rather than decorative. The
 * extractor is a language model reading legal prose, and a language model can
 * produce a plausible sentence that is not on the page. A snippet that cannot
 * be found verbatim in the source is not evidence and is rejected outright.
 */

export interface SourcePage {
  url: string;
  /** ISO 8601 timestamp of the fetch. */
  retrievedAt: string;
  /** Plain text of the page, one block-level element per line. */
  text: string;
  /** Raw HTML, kept so links can be discovered from it. */
  html: string;
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_000_000;

// A small entity table. Vendor pages are ordinary marketing/docs HTML, and
// these cover what shows up in legal prose; numeric entities are decoded
// generically below.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', copy: '©',
  reg: '®', trade: '™', sect: '§',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Reduce HTML to readable text.
 *
 * Deliberately simple: strip scripts, styles, and chrome (nav/header/footer),
 * turn block-level boundaries into newlines, drop the remaining tags, decode
 * entities, collapse whitespace. Good enough for prose; the snippet check
 * below normalizes whitespace on both sides, so exact spacing does not matter.
 */
export function htmlToText(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  h = h.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|blockquote|pre|table|dd|dt)\b[^>]*>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  return h
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Normalize text for containment matching.
 *
 * Both the page text and the model's snippet go through this before
 * comparison, so a snippet is still "verbatim" if it differs only in
 * whitespace, quote style, or dash style -- exactly the things that vary
 * between how a page renders and how a model retypes it. Anything beyond
 * that (a changed word, a dropped clause) fails the match, which is the
 * point.
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True if `snippet` appears verbatim (modulo normalizeForMatch) in `text`. */
export function snippetAppears(snippet: string, text: string): boolean {
  const s = normalizeForMatch(snippet);
  if (s.length === 0) return false;
  return normalizeForMatch(text).includes(s);
}

/**
 * Links worth following from a vendor page.
 *
 * The seed points at the vendor's main developer-access page; the terms that
 * matter are often one click away (a Terms of Use page, a fee schedule, a
 * service base URL directory). We follow same-origin links whose path or
 * anchor text looks relevant, and nothing else -- the job caps the total page
 * count, so this cannot walk a whole docs site.
 */
const RELEVANT_LINK = /terms|fee|pricing|developer[-_ ]?access|regist|sandbox|service[-_ ]?base|authenticat|disclosure|api[-_ ]?access|third[-_ ]?party|partner|onboard/i;

export function discoverLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const found = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    const text = htmlToText(m[2] ?? '');
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.origin !== base.origin) continue;
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/\.(png|jpe?g|gif|svg|pdf|zip|xml|json|css|js)$/i.test(u.pathname)) continue;
    u.hash = '';
    u.search = '';
    if (u.href === base.href) continue;
    if (RELEVANT_LINK.test(u.pathname) || RELEVANT_LINK.test(text)) found.add(u.href);
  }
  return [...found];
}

export class FetchError extends Error {
  url: string;
  status?: number;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
  }
}

export async function fetchPage(url: string): Promise<SourcePage> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'RubyHealth-EHR-Access-Registry/0.1 (+https://www.ruby-health.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const retrievedAt = new Date().toISOString();
  if (!res.ok) throw new FetchError(`HTTP ${res.status} fetching ${url}`, url, res.status);
  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new FetchError(`Page exceeds ${MAX_HTML_BYTES} bytes: ${url}`, url);
  }
  // Record the URL we were redirected to, if any -- that is where the text
  // actually lives, and it is what provenance should cite.
  return { url: res.url || url, retrievedAt, text: htmlToText(html), html };
}

/** Key for "have we fetched this already" -- ignores a trailing slash. */
function canonical(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface GatherResult {
  pages: SourcePage[];
  failures: { url: string; error: string }[];
}

/**
 * Fetch the seed URLs, then relevant links discovered from them, up to
 * `maxPages` in total. Seed URLs are fetched first so they are never crowded
 * out by discovered ones. A failed fetch is recorded and skipped rather than
 * aborting the run -- a vendor's terms page being down is itself a finding.
 */
export async function gatherSources(
  seedUrls: string[],
  opts: { maxPages?: number; follow?: boolean } = {},
): Promise<GatherResult> {
  const maxPages = opts.maxPages ?? 12;
  const follow = opts.follow ?? true;
  const pages: SourcePage[] = [];
  const failures: GatherResult['failures'] = [];
  const seen = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (u: string) => {
    if (!seen.has(canonical(u)) && !queued.has(canonical(u))) { queued.add(canonical(u)); queue.push(u); }
  };
  for (const u of seedUrls) if (u) enqueue(u);

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(canonical(url))) continue;
    seen.add(canonical(url));
    try {
      const page = await fetchPage(url);
      if (seen.has(canonical(page.url)) && page.url !== url) continue; // redirected onto a page we already have
      seen.add(canonical(page.url));
      pages.push(page);
      if (follow) {
        for (const link of discoverLinks(page.html, page.url)) enqueue(link);
      }
    } catch (err) {
      failures.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { pages, failures };
}
