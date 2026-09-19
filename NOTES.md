# Build notes

Written during the initial scaffold. These are the things that bit during
implementation and would bite again.

## Bugs found and fixed while building

**`pg` returns DATE as a local-midnight JS Date.** The default node-postgres
parser turns `2026-09-15` into `Tue Sep 15 2026 00:00:00 GMT-0700`. Converting
that back through `toISOString()` shifts the calendar day whenever the host's
offset is positive. These dates decide whether a vendor missed a statutory
deadline, so a one-day shift driven by server timezone is not survivable.
Fixed by registering a type parser that returns DATE as a plain string
(`src/db/client.ts`). The date validation in `businessDays.ts` is what caught
it -- without that throw it would have silently produced wrong deadlines.

**`pg` returns BIGSERIAL as a string.** `x.id === id` comparing string to number
silently failed as a 404 with nothing in the logs. Fixed with a guarded INT8
parser that throws rather than returning a lossy number.

**A non-compete phrased as an undertaking escaped the compliance check.**
`/non-?compet/` does not match "Partner agrees not to compete with Vendor",
which is how the clause actually reads in contracts. The patterns now cover
both the noun and the undertaking. Worth remembering that every heuristic here
is matching legal prose written by people who were not trying to be matched.

**"No fees are charged" was being flagged as a disclosed fee.** The naive
`/fee|charge|\$/` test flagged the most compliant vendors hardest. There is now
an explicit negation check. Noisy flags train the reader to ignore flags.

**TypeScript parameter properties break Node's type-stripping.** `constructor(
readonly status?: number)` needs a full compile. The jobs run under
`--experimental-strip-types`, so the class now declares plain fields.

**`tsc` alone produces a build that boots and then dies.** `schema.sql` and the
JSON data files are read at runtime relative to the compiled output. The build
script copies them.

**The link follower fetched the same page twice.** `/foo` and `/foo/` both
appeared as links and both redirected to the same page. Deduping happens on a
trailing-slash-insensitive key now, and a fetch that redirects onto a page we
already hold is dropped. Harmless here, but a duplicate page doubles the
extractor's input and would have double-counted in the sync log.

**CHPL's search response is not the shape the client assumed.** The first
live sync crashed: `criteriaMet` is `{id, number, title}[]` not `string[]`,
`certificationStatus` is `{id, name}`, `apiDocumentation` is one
`{criterion, value}` per criterion, and `serviceBaseUrlList` is a single
`{criterion, value}`. `collapseToVendors` now reads both shapes, prefers the
(g)(10) documentation link, and `src/lib/__tests__/chpl.test.ts` pins the
real shape. Unit tests with hand-written fixtures could not have caught this;
only the live call did.

**CHPL rate-limits paging.** Eight pages of 100 in quick succession drew a
429. The client now honours `Retry-After`, backs off exponentially otherwise,
gives up after six attempts, and sleeps a second between pages
(`CHPL_PAGE_DELAY_MS`).

**A vendor disclaiming prohibited conditions was flagged as imposing them.**
The first live extraction of Canvas Medical produced three "violation"
flags from the sentence "We do not condition access on ... non-compete or
exclusive-dealing terms ... fees or royalties" -- the most compliant sentence
a vendor can publish. Same class as the fee bug. The check now recognises a
negation of conditioning/imposing, but not a negation of competing:
"Developer shall not compete" is a real non-compete and is still flagged
(and the original pattern had missed that phrasing too, because it required
a "to" after "not").

## Design decisions that are load-bearing

**Provenance is enforced by the type, not by convention.** `ExtractedField`
requires `sourceUrl`, `retrievedAt`, `confidence`, and `snippet`. There is no
way to record a requirement without its evidence, because the one time someone
skips it will be the time it matters.

**The extractor cannot save what it cannot quote.** The model proposes
fields with a verbatim snippet and a URL; `verifyCandidates` rejects any
snippet that is not found in the fetched text of that URL. The rejection is
printed, not stored. A model can write a perfectly plausible sentence that is
not on the page, and that is exactly the failure this system cannot afford.

**A vanished field is not a deletion.** If a re-fetch does not find a field we
previously held, `diffExtraction` reports nothing. Absence far more often means
a failed fetch or a moved page than a vendor deleting a requirement, and
treating it as deletion would quietly drop a real requirement out of the packet.

**The packet refuses to assert what it cannot support.** Below-threshold
extractions and unconfirmed profile fields become open items rather than
confident statements. A packet that says "confirm this" is better than one that
tells a vendor something false.

**The complaint endpoint returns 409 when there is no breach.** Producing a
draft for a vendor still inside their window would be wrong, and quietly
producing one invites someone to send it.

## Open items for the operator

- `CHPL_API_KEY` must be set before `npm run sync` will do anything.
- The seed vendors have `chplDeveloperId: null` until the first sync resolves
  them. If a name does not match, the sync says so rather than failing silently.
- `requirements` in the seed file are deliberately empty. Hand-writing
  plausible values with invented snippets would defeat the provenance design.
- Ruby's profile has four `needsConfirmation` blocks. Every generated packet
  lists them as open items until they are resolved.
