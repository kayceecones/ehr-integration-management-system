import {
  hashValue, normalizeValue, isUsable, diffExtraction, checkCompliance,
  CONFIDENCE_THRESHOLD, type ExtractedField, type FieldName,
} from '../extract.ts';

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

function field(over: Partial<ExtractedField> & { field: FieldName }): ExtractedField {
  return {
    value: 'x', sourceUrl: 'https://t.test', retrievedAt: '2026-09-19T00:00:00Z',
    confidence: 0.9, snippet: 'snippet', ...over,
  };
}

// Normalization: cosmetic whitespace must not read as a substantive change.
check('whitespace collapses', normalizeValue('a   b\n\nc'), 'a b c');
check('reflow does not change hash', hashValue('a   b'), hashValue('a b'));
check('null distinct from empty', hashValue(null) === hashValue(''), false);
check('real edit changes hash', hashValue('no fee') === hashValue('a fee'), false);

// Usability gate
check('above threshold usable', isUsable(field({ field: 'fees', confidence: 0.9 })), true);
check('at threshold usable', isUsable(field({ field: 'fees', confidence: CONFIDENCE_THRESHOLD })), true);
check('below threshold not usable', isUsable(field({ field: 'fees', confidence: 0.5 })), false);
check('empty snippet not usable', isUsable(field({ field: 'fees', snippet: '  ' })), false);

// Diffing
const prev = new Map<FieldName, { value: string | null; hash: string }>([
  ['fees', { value: 'No fee', hash: hashValue('No fee') }],
  ['auth_flow', { value: 'SMART', hash: hashValue('SMART') }],
]);

const noChange = diffExtraction(prev, [field({ field: 'fees', value: 'No fee' })]);
check('identical value = no change', noChange.length, 0);

const reflowed = diffExtraction(prev, [field({ field: 'fees', value: 'No    fee' })]);
check('reflowed value = no change', reflowed.length, 0);

const feeAdded = diffExtraction(prev, [field({ field: 'fees', value: '$5,000 annual fee' })]);
check('fee change detected', feeAdded.length, 1);
check('fee change is material', feeAdded[0]?.material, true);

const newField = diffExtraction(prev, [field({ field: 'prohibited_conditions', value: 'exclusivity required' })]);
check('newly appeared field detected', newField.length, 1);
check('newly appeared prohibited condition is material', newField[0]?.material, true);

// A field vanishing from the new extraction must NOT be reported as a change --
// absence usually means a failed fetch, and treating it as deletion would
// quietly erase a real requirement from the packet.
const vanished = diffExtraction(prev, [field({ field: 'fees', value: 'No fee' })]);
check('vanished field not reported as deletion', vanished.length, 0);

// Compliance heuristics
const nonCompeteNoun = checkCompliance([
  field({ field: 'prohibited_conditions', value: 'Non-compete clause applies.', snippet: 'Non-compete clause applies.' }),
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
]);
check('non-compete (noun) flagged', nonCompeteNoun.some(f => f.citation === '45 CFR 170.404(a)(4)'), true);

// The phrasing that actually appears in contracts, and that a naive
// /non-?compet/ regex misses entirely.
const nonCompeteVerb = checkCompliance([
  field({ field: 'prohibited_conditions', value: 'Partner agrees not to compete with Vendor in any market.', snippet: 'Partner agrees not to compete with Vendor in any market.' }),
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
]);
check('non-compete (as an undertaking) flagged', nonCompeteVerb.some(f => f.citation === '45 CFR 170.404(a)(4)'), true);
check('non-compete is a violation not a concern', nonCompeteVerb.find(f => f.citation === '45 CFR 170.404(a)(4)')?.severity, 'violation');

const revShare = checkCompliance([
  field({ field: 'prohibited_conditions', value: 'Vendor receives a percentage of revenue from partner sales.', snippet: 'Vendor receives a percentage of revenue.' }),
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
]);
check('revenue share flagged', revShare.some(f => f.citation === '45 CFR 170.404(a)(4)'), true);

const docFee = checkCompliance([
  field({ field: 'fees', value: 'Access to the API documentation requires a $500 fee.', snippet: 'Documentation access: $500.' }),
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
]);
check('documentation fee is a violation',
  docFee.find(f => f.citation === '45 CFR 170.404(a)(3)')?.severity, 'violation');

const plainFee = checkCompliance([
  field({ field: 'fees', value: 'Annual partner fee of $5,000.', snippet: 'Annual partner fee: $5,000.' }),
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
]);
check('ordinary fee is a concern, not a violation',
  plainFee.find(f => f.citation === '45 CFR 170.404(a)(3)')?.severity, 'concern');

// A vendor stating it charges nothing must not trip the fee heuristic --
// otherwise the most compliant vendors get flagged hardest and the reader
// learns to ignore flags.
for (const phrasing of [
  'No fees are charged for API access.',
  'There are no fees for use of the API.',
  'API access is provided free of charge.',
  'No additional cost for production access.',
]) {
  const r = checkCompliance([
    field({ field: 'registration_url', value: 'https://t.test/reg' }),
    field({ field: 'fees', value: phrasing, snippet: phrasing }),
  ]);
  check(`no-fee phrasing not flagged: "${phrasing.slice(0, 32)}..."`, r.length, 0);
}

const noReg = checkCompliance([field({ field: 'fees', value: null })]);
check('missing registration path flagged under (a)(2)',
  noReg.some(f => f.citation === '45 CFR 170.404(a)(2)'), true);

const clean = checkCompliance([
  field({ field: 'registration_url', value: 'https://t.test/reg' }),
  field({ field: 'fees', value: 'No fees are charged for API access.', snippet: 'No fees are charged.' }),
  field({ field: 'prohibited_conditions', value: null }),
]);
check('clean vendor raises nothing', clean.length, 0);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
