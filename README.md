# EHR Integration Management System

Internal tooling for Ruby Health LLC.

## What this is

Ruby needs API access to the EHRs its customers already use. Getting that access
is not a favor we ask for — for any EHR certified under the ONC Health IT
Certification Program, it is a regulatory obligation.

Under **45 CFR 170.404**, a Certified API Developer (the EHR vendor) must:

- publish all terms, fees, restrictions, and registration requirements for its
  certified API technology;
- complete authenticity verification of an API User (us) within **10 business
  days** of receiving our registration request;
- register and enable our application for production use within **5 business
  days** of completing that verification;
- refrain from charging for documentation, or for anything essential to
  developing and commercially distributing production-ready applications;
- refrain from conditioning access on non-compete, exclusivity, or
  royalty/revenue-share terms.

Separately, under 170.404(a)(4), the **practice** — not the vendor — decides
whether to permit us to reach its data. The vendor does not get to sit between
Ruby and its customer.

This system turns that from a vague waiting game into a tracked, enforceable
process.

## What it does

1. **Registry.** Syncs the ONC Certified Health IT Product List (CHPL) and
   filters to vendors certified under §170.315(g)(10) — the ones that owe us
   API access.
2. **Requirements extraction.** For each vendor, fetches their published terms
   and developer documentation and normalizes them into a comparable schema.
   Every extracted field carries its source URL, the date it was retrieved, an
   extraction confidence, and the verbatim snippet it came from. Nothing in the
   registry is an unattributed assertion.
3. **Company profile.** Ruby's canonical facts live in one file, answered once
   rather than re-answered per vendor.
4. **Packet generation.** Profile × vendor requirements produces a submission
   packet, written to a Notion page and linked from that vendor's tracker row.
   Generation never sends anything — a human reviews and submits.
5. **Clock tracking.** Once a request is marked sent, both regulatory deadlines
   are computed in business days (weekends and federal holidays excluded). A
   daily job classifies each request as on time, due soon, or overdue.
6. **Change detection.** Vendor terms are re-fetched on a schedule and
   normalized fields are hashed. A quiet fee addition or a new attestation
   requirement surfaces as a diff for review.

## Why provenance matters here

The requirements in this registry are extracted from legal terms by a language
model, and we act on them — we submit packets based on them, and we may
escalate to ONC based on the dates they imply. An extraction that cannot be
traced to a source sentence is not evidence. Every field is therefore stored
with its provenance, and the packet generator refuses to assert any requirement
whose confidence falls below threshold, flagging it for human review instead.

## Deadlines are in business days

The 10-day and 5-day clocks in 170.404(b)(1) are business days. If a tracked
deadline is ever going to back an information-blocking complaint, the date
arithmetic has to be defensible — so `src/lib/businessDays.ts` excludes
weekends and the eleven US federal holidays, including observed-day shifts when
a holiday falls on a weekend.

## Scope of the current build

Three vendors, chosen for contrasting posture rather than coverage:

| Vendor | Posture | Why it's here |
| --- | --- | --- |
| Canvas Medical | Developer-first; publishes its access process openly | The easy case |
| athenahealth | Incumbent; heavier partner program | The hard case |
| Elation Health | Mid-market, built for independent primary care | Closest to Ruby's buyer |

The registry sync is written to handle the full CHPL result set; it is filtered
to these three for now.

## Stack

- Node / TypeScript, Fastify
- Postgres (Render)
- Notion as the human workflow surface

## Layout

```
src/
  db/schema.sql          Postgres schema: vendors, requirements, provenance, requests
  lib/businessDays.ts    Federal-holiday-aware business day arithmetic
  lib/chpl.ts            CHPL Open API client
  lib/extract.ts         Field vocabulary, provenance, normalization, diffing
  lib/terms.ts           Fetches vendor pages; verifies snippets are verbatim
  lib/extractor.ts       Claude extraction pass, gated by that verification
  lib/packet.ts          Submission packet generator
  lib/notion.ts          Mirrors request state to the Notion tracker
  jobs/syncRegistry.ts   CHPL sync
  jobs/checkClocks.ts    Daily deadline classification
  jobs/extractTerms.ts   Reads each vendor's published terms into the registry
  profile/ruby-health.json  Ruby's canonical facts
  server.ts              Fastify API
```

## Running it

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL and CHPL_API_KEY
npm run build
npm run migrate          # idempotent; safe to re-run
npm run sync             # pull CHPL, match the in-scope vendors
npm run extract          # read each vendor's published terms (needs ANTHROPIC_API_KEY)
npm start
```

The scripts load `.env` when it exists. `npm test` runs the clock, extraction,
terms-verification, and name-matching suites (116 assertions, no database or
API key required).

## How extraction works

`npm run extract` fetches the pages listed in each vendor's `sourceUrls` (plus
same-origin links that look like terms, fees, or registration pages, up to a
small cap), reduces them to text, and asks Claude to fill the field vocabulary
in `src/lib/extract.ts`, citing the URL and the verbatim sentence for each.

Nothing the model says is saved as-is. `verifyCandidates` checks that every
snippet actually appears in the fetched text of the page it cites; a candidate
whose snippet cannot be found is rejected and printed, never stored. That
check is what turns a model's output into evidence a human can open the URL
and confirm.

```bash
npm run extract -- --vendor "Canvas Medical" --dry-run   # no database; prints what it would save
npm run extract -- --vendor "Canvas Medical"             # saves, diffs against prior values
```

## Environment

See `.env.example`. `CHPL_API_KEY` is a free read-only key from
chpl.healthit.gov. `ANTHROPIC_API_KEY` is needed only by `npm run extract`.
The Notion variables are optional -- with them unset the mirror is a no-op and
everything else still runs.

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/vendors` | In-scope vendors (`?all=true` for the full registry) |
| GET | `/requests` | Requests with freshly recomputed clocks |
| GET | `/vendors/:id/requirements` | Extracted requirements with provenance, plus compliance flags |
| GET | `/vendors/:id/packet` | Submission packet (`?format=markdown` for the raw text) |
| GET | `/requests/:id/complaint` | Complaint draft; **409 if the request is not actually in breach** |
| POST | `/requests/:id/dates` | Record that a request was sent / verified / enabled |
| POST | `/jobs/clocks` | Re-run the deadline classification now |

## Two behaviors worth knowing about

**A breach is never un-recorded.** When a vendor misses a deadline and then
catches up, the request's status moves on but `blocking_concern` stays set. The
vendor was late; that remains true afterwards, and it is the kind of fact you
want when deciding whether to escalate a later delay.

**Both deadlines are always stored.** `verification_due` is computed and kept
even after verification is complete. It is the record of what the vendor was
obliged to do and when -- what an escalation would be reconstructed from.

## What this system will not do

It does not submit anything on Ruby's behalf. It does not file complaints
automatically. It drafts, tracks, and surfaces — a human decides and sends.
