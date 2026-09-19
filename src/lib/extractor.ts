/**
 * The extraction pass: published vendor pages in, attributable fields out.
 *
 * A language model reads the fetched pages and proposes a value for each
 * field in the vocabulary, citing the URL and the verbatim sentence that
 * supports it. Nothing the model says is trusted on its own: every proposal
 * then goes through `verifyCandidates`, which rejects any snippet that does
 * not actually appear in the fetched text of the cited page. What survives is
 * evidence in the sense this system requires -- a sentence a human can open
 * the URL and find. What does not survive is discarded and reported, never
 * saved.
 */

import Anthropic from '@anthropic-ai/sdk';
import { FIELDS, FIELD_NAMES, type ExtractedField, type FieldName } from './extract.ts';
import { snippetAppears, type SourcePage } from './terms.ts';

export const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? 'claude-opus-5';

/** What the model proposes, before verification. */
export interface Candidate {
  field: string;
  value: string | null;
  sourceUrl: string;
  snippet: string;
  confidence: number;
  note?: string;
}

/** Snippets longer than this are a paragraph, not a supporting sentence. */
const MAX_SNIPPET_CHARS = 1500;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: FIELD_NAMES },
          value: { type: ['string', 'null'] },
          sourceUrl: { type: 'string' },
          snippet: { type: 'string' },
          confidence: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['field', 'value', 'sourceUrl', 'snippet', 'confidence', 'note'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['fields', 'notes'],
  additionalProperties: false,
} as const;

function systemPrompt(): string {
  const vocab = FIELD_NAMES.map((f) => `- ${f}: ${FIELDS[f]}`).join('\n');
  return `You extract an EHR vendor's published API access terms into a fixed vocabulary of fields. The vendor is a Certified API Developer under 45 CFR 170.404 and is obligated to publish its terms, fees, and registration requirements; you are reading what it published.

The record you produce may be relied on in a submission to the vendor and, if a deadline is missed, in a complaint to ONC. Every field must therefore be traceable to a sentence on the page. Follow these rules exactly:

1. For each field below, propose at most one entry.
2. "snippet" must be copied VERBATIM from the provided page text: the exact characters, in order, from one contiguous passage. Do not paraphrase, do not shorten with ellipses, do not stitch together sentences from different places. Prefer one to three complete sentences. If you cannot quote a passage that supports the value, do not propose a value.
3. "sourceUrl" must be exactly one of the page URLs provided. Never invent or alter a URL.
4. "value" is a concise statement of what the vendor says, in your own words. It may summarize; the snippet is the evidence.
5. Use value null only when you have checked every provided page and the vendor does not address the field. Then set snippet to an empty string and sourceUrl to the page most likely to have covered it.
6. "confidence" is between 0 and 1 and expresses how directly the snippet establishes the value. 0.9 or above: the snippet states it explicitly. 0.6 to 0.85: the snippet implies it or covers only part of it. Below 0.5: you are guessing. Be honest; a low confidence is far better than a wrong assertion.
7. Use only the provided text. Do not draw on anything you otherwise know about this vendor.
8. "note" is for anything a human reviewer should know about the entry (ambiguity, a second relevant passage, a page that may be out of date). Use an empty string when there is nothing to say.

Fields:
${vocab}

Put anything about the pages as a whole (a page that looked truncated, terms that seem to contradict each other) in the top-level "notes".`;
}

function pagesAsPrompt(vendorName: string, pages: SourcePage[]): string {
  const parts = pages.map(
    (p, i) => `<page index="${i + 1}" url="${p.url}" retrieved="${p.retrievedAt}">\n${p.text}\n</page>`,
  );
  return `Vendor: ${vendorName}\n\nPublished pages (${pages.length}):\n\n${parts.join('\n\n')}`;
}

/**
 * Ask the model for candidates. The result is unverified; call
 * `verifyCandidates` before treating any of it as a field.
 */
export async function proposeCandidates(
  vendorName: string,
  pages: SourcePage[],
  client: Anthropic = new Anthropic(),
): Promise<{ candidates: Candidate[]; notes: string; usage: Anthropic.Usage }> {
  if (pages.length === 0) throw new Error('No pages to extract from.');

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 16000,
      system: systemPrompt(),
      messages: [{ role: 'user', content: pagesAsPrompt(vendorName, pages) }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    });
  } catch (err) {
    if (err instanceof Error && /authentication method/i.test(err.message)) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. The extractor reads vendor pages with Claude; ' +
          'put a key in .env (see .env.example) or run `ant auth login`.',
      );
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(`Extraction refused: ${response.stop_details?.explanation ?? 'no explanation'}`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Extraction output was truncated (max_tokens); nothing saved.');
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Extraction returned no text block.');

  const parsed = JSON.parse(text.text) as { fields: Candidate[]; notes: string };
  return { candidates: parsed.fields ?? [], notes: parsed.notes ?? '', usage: response.usage };
}

export interface Rejection {
  candidate: Candidate;
  reason: string;
}

export interface VerifiedExtraction {
  accepted: ExtractedField[];
  rejected: Rejection[];
}

/**
 * The gate. A candidate becomes a field only if:
 *  - its field name is in the vocabulary,
 *  - its sourceUrl is one of the pages we actually fetched,
 *  - its confidence is a number in [0, 1],
 *  - and, when it asserts a value, its snippet is non-empty, not absurdly
 *    long, and appears verbatim in the text of the cited page.
 *
 * A null value (vendor does not state this) needs no snippet but still needs
 * a real page to point at, so the packet can say where we looked.
 *
 * Duplicate fields keep the higher-confidence entry.
 */
export function verifyCandidates(candidates: Candidate[], pages: SourcePage[]): VerifiedExtraction {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const accepted = new Map<FieldName, { field: ExtractedField; candidate: Candidate }>();
  const rejected: Rejection[] = [];
  const known = new Set<string>(FIELD_NAMES);

  for (const c of candidates) {
    const reject = (reason: string) => rejected.push({ candidate: c, reason });

    if (!known.has(c.field)) { reject(`unknown field "${c.field}"`); continue; }
    const page = byUrl.get(c.sourceUrl);
    if (!page) { reject(`sourceUrl is not a fetched page: ${c.sourceUrl}`); continue; }
    if (typeof c.confidence !== 'number' || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      reject(`confidence out of range: ${String(c.confidence)}`); continue;
    }

    let snippet = c.snippet ?? '';
    if (c.value !== null) {
      if (typeof c.value !== 'string' || c.value.trim().length === 0) { reject('empty value'); continue; }
      if (snippet.trim().length === 0) { reject('value asserted without a snippet'); continue; }
      if (snippet.length > MAX_SNIPPET_CHARS) { reject(`snippet too long (${snippet.length} chars)`); continue; }
      if (!snippetAppears(snippet, page.text)) { reject('snippet not found verbatim on the cited page'); continue; }
    } else {
      // Nothing to quote for an absence. Do not let a stray snippet through
      // as though it were evidence of something.
      snippet = '';
    }

    const field: ExtractedField = {
      field: c.field as FieldName,
      value: c.value,
      sourceUrl: page.url,
      retrievedAt: page.retrievedAt,
      confidence: Math.round(c.confidence * 100) / 100,
      snippet,
    };
    const existing = accepted.get(field.field);
    if (!existing) {
      accepted.set(field.field, { field, candidate: c });
    } else if (existing.field.confidence < field.confidence) {
      rejected.push({ candidate: existing.candidate, reason: `duplicate of a higher-confidence entry for ${field.field}` });
      accepted.set(field.field, { field, candidate: c });
    } else {
      reject(`duplicate of a higher-confidence entry for ${field.field}`);
    }
  }

  return { accepted: [...accepted.values()].map((a) => a.field), rejected };
}

/** Fetch nothing, decide nothing: propose, then verify. */
export async function extractFromPages(
  vendorName: string,
  pages: SourcePage[],
  client?: Anthropic,
): Promise<VerifiedExtraction & { notes: string; usage: Anthropic.Usage }> {
  const { candidates, notes, usage } = await proposeCandidates(vendorName, pages, client);
  return { ...verifyCandidates(candidates, pages), notes, usage };
}
