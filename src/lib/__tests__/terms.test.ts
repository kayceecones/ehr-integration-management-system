import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  htmlToText, decodeEntities, normalizeForMatch, snippetAppears, discoverLinks, type SourcePage,
} from '../terms.ts';
import { verifyCandidates, type Candidate } from '../extractor.ts';

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures', 'canvas-developer-access.html'), 'utf8');
const fixtureUrl = 'https://docs.canvasmedical.com/api/developer-access/';
const page: SourcePage = {
  url: fixtureUrl, retrievedAt: '2026-09-19T21:00:00.000Z', html: fixtureHtml, text: htmlToText(fixtureHtml),
};

// --- HTML to text ----------------------------------------------------------

check('scripts stripped', page.text.includes('should be stripped'), false);
check('styles stripped', page.text.includes('color:red'), false);
check('nav chrome stripped', page.text.includes('nav chrome'), false);
check('footer chrome stripped', page.text.includes('footer chrome'), false);
check('comments stripped', page.text.includes('Trimmed <article>'), false);
check('body prose retained',
  page.text.includes('There is no fee to register, verify, or enable a third-party application for access to the API.'),
  true);
check('block elements become lines', htmlToText('<p>a</p><p>b</p>'), 'a\nb');
check('inline tags do not split words', htmlToText('<p>ten <strong>business</strong> days</p>'), 'ten business days');
check('named entities decoded', decodeEntities('Terms &amp; Conditions &sect; 2'), 'Terms & Conditions § 2');
check('numeric entities decoded', decodeEntities('&#8220;quoted&#8221; &#x27;x&#x27;'), '“quoted” \'x\'');

// --- Snippet verification ---------------------------------------------------

const exact = 'We complete an authenticity-verification review. This process is objective and applied uniformly to all API users, and we complete it within ten business days of receiving your request.';
check('verbatim snippet found', snippetAppears(exact, page.text), true);
check('reflowed whitespace still found', snippetAppears(exact.replace(/ /g, '  \n '), page.text), true);
check('straight quotes match curly quotes',
  snippetAppears("Canvas Medical is certified to ONC's §170.315(g)(10)", page.text), true);
check('case-insensitive match', snippetAppears(exact.toUpperCase(), page.text), true);
check('one changed word fails',
  snippetAppears(exact.replace('ten business days', 'fifteen business days'), page.text), false);
check('plausible fabrication fails',
  snippetAppears('A $500 annual fee applies to production API access.', page.text), false);
check('stitched sentences fail',
  snippetAppears('There is no fee to register. Contact us at developer-access@canvasmedical.com', page.text), false);
check('empty snippet never matches', snippetAppears('   ', page.text), false);
check('normalize collapses quotes and dashes', normalizeForMatch('“A” — ‘b’'), '"a" - \'b\'');

// --- Link discovery ---------------------------------------------------------

const links = discoverLinks(page.html, fixtureUrl);
check('follows the terms of use link', links.includes('https://docs.canvasmedical.com/api/terms-of-use/'), true);
check('follows the service base URL link', links.includes('https://docs.canvasmedical.com/api/service-base-urls/'), true);
check('does not follow mailto', links.some((l) => l.startsWith('mailto:')), false);
check('does not include the page itself', links.includes(fixtureUrl), false);
check('same-origin only',
  discoverLinks('<a href="https://elsewhere.example/terms">Terms</a><a href="/terms">Terms</a>', 'https://v.example/x'),
  ['https://v.example/terms']);
check('irrelevant links ignored',
  discoverLinks('<a href="/blog/hello">Hello</a><a href="/careers">Careers</a>', 'https://v.example/x'),
  []);
check('fragments and queries stripped',
  discoverLinks('<a href="/pricing?utm=1#top">Pricing</a>', 'https://v.example/x'),
  ['https://v.example/pricing']);

// --- The gate: verifyCandidates ---------------------------------------------

function cand(over: Partial<Candidate>): Candidate {
  return { field: 'fees', value: 'No fee', sourceUrl: fixtureUrl, snippet: exact, confidence: 0.9, note: '', ...over };
}

const good = verifyCandidates([cand({
  field: 'fees',
  value: 'No fee to register, verify, or enable an application.',
  snippet: 'There is no fee to register, verify, or enable a third-party application for access to the API.',
})], [page]);
check('verbatim candidate accepted', good.accepted.length, 1);
check('accepted field carries page retrievedAt', good.accepted[0]?.retrievedAt, page.retrievedAt);
check('accepted field cites the fetched URL', good.accepted[0]?.sourceUrl, fixtureUrl);

const fabricated = verifyCandidates([cand({ snippet: 'A $500 annual fee applies to production API access.' })], [page]);
check('fabricated snippet rejected', fabricated.accepted.length, 0);
check('rejection names the reason', fabricated.rejected[0]?.reason, 'snippet not found verbatim on the cited page');

check('unknown field rejected',
  verifyCandidates([cand({ field: 'vibes' })], [page]).rejected[0]?.reason, 'unknown field "vibes"');
check('unfetched URL rejected',
  verifyCandidates([cand({ sourceUrl: 'https://docs.canvasmedical.com/api/other/' })], [page]).accepted.length, 0);
check('value without snippet rejected',
  verifyCandidates([cand({ snippet: '' })], [page]).rejected[0]?.reason, 'value asserted without a snippet');
check('confidence above 1 rejected', verifyCandidates([cand({ confidence: 1.2 })], [page]).accepted.length, 0);
check('confidence below 0 rejected', verifyCandidates([cand({ confidence: -0.1 })], [page]).accepted.length, 0);
check('overlong snippet rejected',
  verifyCandidates([cand({ snippet: 'x'.repeat(1501) })], [page]).rejected[0]?.reason, 'snippet too long (1501 chars)');

const absent = verifyCandidates([cand({ field: 'baa_required', value: null, snippet: 'stray text', confidence: 0.8 })], [page]);
check('null value accepted without snippet', absent.accepted.length, 1);
check('null value never carries a snippet', absent.accepted[0]?.snippet, '');

const dup = verifyCandidates([
  cand({ confidence: 0.6, value: 'weaker' }),
  cand({ confidence: 0.95, value: 'stronger' }),
], [page]);
check('duplicate keeps higher confidence', dup.accepted.map((f) => f.value), ['stronger']);
check('duplicate loser is reported', dup.rejected.length, 1);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
