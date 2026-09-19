import { collapseToVendors, owesApiAccess, type ChplListing } from '../chpl.ts';

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

// The shape /search/v3 actually returns (captured 2026-09-19). The first
// sync against the live API crashed on criteriaMet being objects, not
// strings; this pins the real shape so that cannot regress.
const g10 = { id: 182, number: '170.315 (g)(10)', title: 'Standardized API for Patient and Population Services' };
const g9 = { id: 181, number: '170.315 (g)(9)', title: 'Application Access - All Data Request' };
const live: ChplListing = {
  id: 1, chplProductNumber: '15.04.04.2122.1Lif.01.00.1.190328',
  developer: { id: 2122, name: '1Life Healthcare, Inc', status: null },
  product: { id: 3644, name: '1Life' },
  certificationStatus: { id: 1, name: 'Active' },
  criteriaMet: [{ id: 177, number: '170.315 (d)(13)', title: 'Multi-Factor Authentication' }, g10],
  apiDocumentation: [
    { criterion: g9, value: 'https://apidocs.example/g9' },
    { criterion: g10, value: 'https://apidocs.example/fhir/overview/' },
  ],
  serviceBaseUrlList: { criterion: g10, value: 'https://apidocs.example/bundle.json' },
  mandatoryDisclosures: 'https://apidocs.example/legal/declaration_of_conformity/',
};

const [v] = collapseToVendors([live]);
check('criteria numbers extracted from objects', v?.certifiedCriteria, ['170.315 (d)(13)', '170.315 (g)(10)']);
check('status name extracted from object', v?.chplStatus, 'Active');
check('g10 documentation preferred over g9', v?.apiDocumentationUrl, 'https://apidocs.example/fhir/overview/');
check('service base URL value extracted', v?.serviceBaseUrlList, 'https://apidocs.example/bundle.json');
check('mandatory disclosures kept', v?.termsUrl, 'https://apidocs.example/legal/declaration_of_conformity/');
check('g10 holder owes API access', v ? owesApiAccess(v) : null, true);

// Second listing from the same developer unions criteria, does not duplicate.
const second: ChplListing = {
  ...live, id: 2, product: { id: 9, name: 'Other' },
  criteriaMet: [g10, { id: 1, number: '170.315 (a)(1)' }],
  apiDocumentation: [{ criterion: g10, value: 'https://apidocs.example/second' }],
};
const merged = collapseToVendors([live, second]);
check('one record per developer', merged.length, 1);
check('criteria unioned without duplicates', merged[0]?.certifiedCriteria, ['170.315 (d)(13)', '170.315 (g)(10)', '170.315 (a)(1)']);
check('first documentation link wins', merged[0]?.apiDocumentationUrl, 'https://apidocs.example/fhir/overview/');
check('product names collected', merged[0]?.productNames, ['1Life', 'Other']);

// Legacy string shapes still work, so a shape change in either direction is
// not a crash.
const legacy: ChplListing = {
  id: 3, chplProductNumber: 'x', developer: { id: 7, name: 'Legacy' }, product: { id: 1, name: 'P' },
  certificationStatus: 'Active', criteriaMet: ['170.315 (g)(10)'],
  apiDocumentation: 'https://legacy.example/docs', serviceBaseUrlList: 'https://legacy.example/bundle',
};
const [l] = collapseToVendors([legacy]);
check('string criteria accepted', l?.certifiedCriteria, ['170.315 (g)(10)']);
check('string documentation accepted', l?.apiDocumentationUrl, 'https://legacy.example/docs');
check('string status accepted', l?.chplStatus, 'Active');

// A developer with no API criterion does not owe access.
const noApi: ChplListing = { ...legacy, id: 4, developer: { id: 8, name: 'NoApi' }, criteriaMet: [{ id: 1, number: '170.315 (a)(1)' }] };
const [n] = collapseToVendors([noApi]);
check('non-API developer does not owe access', n ? owesApiAccess(n) : null, false);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
