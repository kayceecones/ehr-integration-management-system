/**
 * The control centre API.
 *
 * Read endpoints expose registry and request state. Write endpoints record
 * what a human did -- that a request was sent, that a vendor verified us, that
 * production was enabled. Nothing here contacts a vendor.
 */

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate, db, listVendors, listRequests, loadFields } from './db/client.ts';
import { classifyClock } from './lib/businessDays.ts';
import { checkClocks } from './jobs/checkClocks.ts';
import { generatePacket, type RubyProfile } from './lib/packet.ts';
import { checkCompliance } from './lib/extract.ts';
import { draftComplaint } from './lib/complaint.ts';

const here = dirname(fileURLToPath(import.meta.url));

function profile(): RubyProfile {
  return JSON.parse(
    readFileSync(join(here, 'profile', 'ruby-health.json'), 'utf8'),
  ) as RubyProfile;
}

const app = Fastify({ logger: true });

/**
 * The UI: one static page that talks to the endpoints below. Served from the
 * same origin so there is no CORS to configure, and read at request time so
 * an edit to the file shows up without a restart in `npm run dev`.
 */
app.get('/', async (_req, reply) => {
  const html = readFileSync(join(here, 'ui', 'index.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

/** A JSON index of the API. */
app.get('/api', async () => ({
  name: 'EHR Integration Management System',
  description: 'Tracks API access requests to ONC-certified EHR vendors under 45 CFR 170.404. Read-mostly; nothing here contacts a vendor.',
  endpoints: {
    'GET /': 'The UI',
    'GET /health': 'Liveness',
    'GET /vendors': 'In-scope vendors (?all=true for the full registry)',
    'GET /requests': 'Access requests with freshly recomputed clocks',
    'GET /vendors/:id/requirements': 'Extracted requirements with provenance, plus compliance flags',
    'GET /vendors/:id/packet': 'Submission packet (?format=markdown for the raw text)',
    'GET /requests/:id/complaint': 'Complaint draft; 409 if the request is not actually in breach',
    'POST /requests': 'Open a request to track for a vendor ({ vendorId })',
    'POST /requests/:id/dates': 'Record that a request was sent / verified / enabled',
    'POST /jobs/clocks': 'Re-run the deadline classification now',
  },
}));

app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

app.get('/vendors', async (req) => {
  const all = (req.query as { all?: string }).all === 'true';
  return { vendors: await listVendors(!all) };
});

app.get('/requests', async () => {
  const rows = await listRequests();
  return {
    requests: rows.map((r) => ({
      ...r,
      // Recomputed live so a stale cron run cannot make the API lie about a
      // deadline. The stored value is what Notion mirrors; this is the truth.
      clock: classifyClock({
        requestSent: r.request_sent,
        verificationCompleted: r.verification_completed,
        productionEnabled: r.production_enabled,
      }),
    })),
  };
});

app.get('/vendors/:id/requirements', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad vendor id' });
  const fields = await loadFields(id);
  return { fields, flags: checkCompliance(fields) };
});

app.get('/vendors/:id/packet', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad vendor id' });

  const vendors = await listVendors(false);
  const v = vendors.find((x) => x.id === id);
  if (!v) return reply.code(404).send({ error: 'vendor not found' });

  const fields = await loadFields(id);
  const packet = generatePacket(
    profile(),
    {
      name: v.name,
      chplDeveloperId: v.chpl_developer_id,
      certifiedCriteria: v.certified_criteria,
      developerPortalUrl: v.developer_portal_url,
      termsUrl: v.terms_url,
      apiDocumentationUrl: v.api_documentation_url,
      contactEmail: v.contact_email,
    },
    fields,
    checkCompliance(fields),
  );

  if ((req.query as { format?: string }).format === 'markdown') {
    return reply.type('text/markdown; charset=utf-8').send(packet.markdown);
  }
  return packet;
});

/**
 * Draft a complaint for a request in breach.
 *
 * Returns 409 rather than a draft when the request is not actually overdue --
 * a complaint drafted against a vendor who is still within their window would
 * be wrong, and quietly producing one invites someone to send it.
 */
app.get('/requests/:id/complaint', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const rows = await listRequests();
  const r = rows.find((x) => x.id === id);
  if (!r) return reply.code(404).send({ error: 'request not found' });

  const clock = classifyClock({
    requestSent: r.request_sent,
    verificationCompleted: r.verification_completed,
    productionEnabled: r.production_enabled,
  });
  if (!clock.breach) {
    return reply.code(409).send({
      error: 'not in breach',
      clock,
      detail: 'No deadline has been missed, so there is nothing to complain about yet.',
    });
  }

  const p = profile();
  const vendors = await listVendors(false);
  const v = vendors.find((x) => x.id === r.vendor_id);

  const md = draftComplaint({
    vendorName: v?.name ?? 'Unknown vendor',
    chplDeveloperId: v?.chpl_developer_id ?? 'unknown',
    certifiedCriteria: v?.certified_criteria ?? [],
    requestSent: r.request_sent!,
    verificationCompleted: r.verification_completed,
    clock,
    requesterEntity: p.entity.legalName,
    requesterContact: p.contacts.technical,
  });

  return reply.type('text/markdown; charset=utf-8').send(md);
});

/**
 * Record what happened. These are the only writes.
 *
 * Opening a request records that a person intends to pursue a vendor. It
 * creates the row the clocks will run against; the clock itself does not
 * start until request_sent is recorded, and nothing here contacts anyone.
 */
app.post('/requests', async (req, reply) => {
  const body = (req.body ?? {}) as { vendorId?: number };
  const vendorId = Number(body.vendorId);
  if (!Number.isInteger(vendorId)) return reply.code(400).send({ error: 'vendorId must be an integer' });

  const vendors = await listVendors(false);
  if (!vendors.some((v) => v.id === vendorId)) return reply.code(404).send({ error: 'vendor not found' });

  // One open request per vendor. A second one would give the clocks two
  // different answers for the same obligation.
  const existing = (await listRequests()).find((r) => r.vendor_id === vendorId && r.production_enabled === null);
  if (existing) return reply.code(409).send({ error: 'an open request already exists for this vendor', request: existing });

  const { rows } = await db().query<{ id: number }>(
    'INSERT INTO access_requests (vendor_id) VALUES ($1) RETURNING id',
    [vendorId],
  );
  const created = (await listRequests()).find((r) => r.id === rows[0]?.id);
  return reply.code(201).send({ request: created });
});

app.post('/requests/:id/dates', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const body = req.body as {
    requestSent?: string; verificationCompleted?: string; productionEnabled?: string;
  };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null && !iso.test(v)) {
      return reply.code(400).send({ error: `${k} must be YYYY-MM-DD` });
    }
  }

  await db().query(
    `UPDATE access_requests SET
       request_sent = COALESCE($2, request_sent),
       verification_completed = COALESCE($3, verification_completed),
       production_enabled = COALESCE($4, production_enabled),
       updated_at = now()
     WHERE id = $1`,
    [id, body.requestSent ?? null, body.verificationCompleted ?? null, body.productionEnabled ?? null],
  );

  await checkClocks();
  const rows = await listRequests();
  return { request: rows.find((r) => r.id === id) };
});

app.post('/jobs/clocks', async () => checkClocks());

const port = Number(process.env.PORT ?? 3000);

try {
  await migrate();
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
