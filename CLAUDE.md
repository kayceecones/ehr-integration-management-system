# CLAUDE.md

Guidance for Claude Code working in this repo.

Read this before changing anything. Several things here look like mistakes or over-engineering and are not. They are load-bearing, and the cost of "simplifying" them is silent wrong answers about legal deadlines.

## What this system is for

Ruby Health LLC requests API access from ONC-certified EHR vendors. Under 45 CFR 170.404 those vendors are obligated to grant it on a clock: ten business days to verify who we are, five more to enable production. This system tracks those clocks, generates the submission packets, and drafts the complaint when a deadline is missed.

The output of this system may end up in a regulatory complaint. That is the standard every change should be held to: a date that is wrong by one day, or a requirement asserted without evidence, is a serious defect, not a rough edge.

## Commands

```bash
npm test              # 136 assertions; no database or API key needed
npx tsc --noEmit      # must be clean
npm run build         # tsc + copies runtime assets into dist/
npm run migrate       # idempotent
npm run sync          # CHPL pull; needs CHPL_API_KEY and DATABASE_URL
npm run clocks        # re-classify deadlines (also runs on every POST /requests/:id/dates)
npm run extract       # read vendors' published terms; needs ANTHROPIC_API_KEY (+ DATABASE_URL unless --dry-run)
```

The `npm run` scripts load `.env` if it exists (`--env-file-if-exists`); on Render the variables come from the environment and there is no file.

Run `npm test` and `npx tsc --noEmit` before considering any change done.

## Invariants — do not remove these

### The `pg` type parsers in `src/db/client.ts`

Two `setTypeParser` calls near the top of the file. Both look like boilerplate someone could delete. Do not.

**DATE → string.** node-postgres parses a DATE into a JavaScript `Date` at local midnight. Converting that back with `toISOString()` shifts the calendar day whenever the host's UTC offset is positive. A deadline stored as 2026-09-15 comes back as 2026-09-14. This was found in integration testing and would otherwise have shipped. DATE is a calendar date with no time or zone; keeping it a string is the only faithful representation.

**INT8 → number.** BIGSERIAL comes back as a string by default. Comparing `row.id === someNumber` then silently fails and surfaces as a 404 with nothing in the logs. The parser throws rather than returning a lossy number if a value ever exceeds the safe integer range.

### The date validation in `businessDays.ts`

`toUTC` re-serializes and compares, rejecting inputs like `2026-02-30` that `Date.UTC` would silently roll forward. This is the check that caught the DATE parsing bug. Removing it makes an entire class of date error invisible.

### `noUncheckedIndexedAccess` in tsconfig

Leave it on. If it produces an error, fix the access — do not disable the flag or add a non-null assertion to make it quiet. Every current error it found was a real possible-undefined.

### Empty `requirements` arrays in `src/db/seed-vendors.json`

These are deliberately empty and must stay that way. Requirements carry provenance — source URL, retrieval date, confidence, and the verbatim snippet. Writing plausible-looking values with invented snippets would produce a system that looks like it has evidence and does not. Populate them by running the extractor (`npm run extract`) against vendors' actually-published terms, never by hand. `sourceUrls` on a seed entry is the one thing you should add by hand: it is a pointer to where the vendor publishes, not a claim about what they say.

### Required provenance on `ExtractedField`

All four provenance fields are non-optional in the type. Do not make them optional to simplify a call site. The type is where this rule is cheapest to enforce, and the one time someone skips it will be the time it matters.

### The snippet gate in `src/lib/extractor.ts`

`verifyCandidates` rejects any extracted field whose snippet does not appear verbatim (whitespace, quote style, and dash style normalized — nothing else) in the fetched text of the page it cites. This is the only thing standing between "a language model said so" and "evidence". The model is asked to copy exact sentences; the gate is what checks that it did. Do not loosen the match to fuzzy or partial, do not let a rejected candidate through with a lowered confidence, and do not save anything that has not been through it. Rejections are printed so a human can see what the model tried to claim.

### No TypeScript parameter properties

`constructor(readonly foo: string)` requires a full compile and breaks under Node's `--experimental-strip-types`, which the jobs run under. Declare fields explicitly. See `ChplError` in `src/lib/chpl.ts`.

### The build must copy assets

`schema.sql`, `seed-vendors.json`, and `ruby-health.json` are read at runtime relative to the compiled output. `tsc` alone produces a build that boots and then dies. The `copy-assets` script handles this; keep it wired into `build`.

## Behaviors that are intentional

**A vanished field is not a deletion.** If a re-fetch does not find a field we previously held, `diffExtraction` reports nothing. Absence far more often means a failed fetch or a moved page than a vendor deleting a requirement, and treating it as deletion would quietly drop a real requirement out of a packet. Do not "fix" this by emitting deletions.

**`blocking_concern` is only ever raised, never cleared.** Both the SQL in `updateClock` and the Notion mirror enforce this. When a vendor misses a deadline and then catches up, the status moves on but the flag stays. They were late; that remains true, and it is what informs whether to escalate a later delay. A human clears it, not a job.

**Both deadlines are always stored.** `verification_due` is computed and kept even after verification completes. It is the record of what the vendor owed and when — what an escalation would be reconstructed from.

**The complaint endpoint returns 409 when there is no breach.** Producing a draft against a vendor still inside their window would be wrong, and quietly producing one invites someone to send it.

**The packet refuses to assert what it cannot support.** Below-threshold extractions and profile fields marked `needsConfirmation` become open items rather than confident statements. A packet currently reports ~20 open items and `readyToSend: false`. That is the system working, not a bug to suppress.

**Compliance flags are flags, not conclusions.** `checkCompliance` runs heuristics over legal prose. Its output says "go read this snippet", never "we have established non-compliance." Keep that framing in any wording changes.

## The hard rule

Nothing in this system contacts a vendor, submits anything, or files anything. It drafts, tracks, and surfaces. A person reads the output and decides. Do not add a send step, an auto-submit, or an automatic filing — not behind a flag, not behind a confirmation prompt. If a task seems to call for one, stop and ask.

## Working on the compliance heuristics

If you touch `checkCompliance`, remember what it is matching: contract language written by people who were not trying to be matched. Two cases already found:

* A non-compete reads "Partner agrees not to compete", which `/non-?compet/` misses entirely.
* "No fees are charged" trips a naive `/fee|charge/` test, flagging the most compliant vendors hardest — and noisy flags train the reader to ignore flags.
* Canvas's "We do **not** condition access on … non-compete or exclusive-dealing terms … fees or royalties" was flagged as three violations on the first live run. `disclaimsProhibitedConditions` handles negation of *conditioning*; `undertakesProhibitedCondition` makes sure "Partner shall not compete" — a real non-compete phrased with "not" — is still caught.

Add a test case for every new pattern. `src/lib/__tests__/extract.test.ts`.

## Layout

```
src/
  db/client.ts           Pool, type parsers, shared queries
  db/schema.sql          Tables; read at runtime, copied by build
  db/seed-vendors.json   The three in-scope vendors
  lib/businessDays.ts    Federal-holiday-aware deadline math  [most load-bearing]
  lib/chpl.ts            CHPL Open API client
  lib/extract.ts         Field vocabulary, provenance, diffing, compliance checks
  lib/terms.ts           Fetch vendor pages, HTML->text, verbatim snippet check
  lib/extractor.ts       Claude extraction pass + the snippet gate
  lib/packet.ts          Submission packet generator
  lib/complaint.ts       ONC complaint drafter
  lib/notion.ts          One-way mirror to the tracker; no-op when unconfigured
  jobs/syncRegistry.ts   CHPL sync
  jobs/checkClocks.ts    Deadline classification; on demand, no scheduled cron
  jobs/extractTerms.ts   Terms extraction; --dry-run needs no database
  profile/ruby-health.json  Ruby's canonical facts
  server.ts              Fastify API
```

## Context

`NOTES.md` has the build log — the four bugs found during integration testing and why each fix looks the way it does. Worth reading before changing anything in `db/` or `businessDays.ts`.
