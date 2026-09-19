/**
 * Mirrors request state into the Notion tracker.
 *
 * Postgres is the source of truth; Notion is the surface a human works on.
 * The mirror is one-directional for computed fields (clock status, deadlines)
 * and deliberately does not overwrite the free-text columns a person edits by
 * hand -- Notes, and Blocking Concern once someone has ticked it.
 *
 * The mirror is optional. With NOTION_TOKEN unset every function here is a
 * no-op, so the system runs headless without it.
 */

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

export function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_TOKEN && process.env.NOTION_DATA_SOURCE_ID);
}

async function notion(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function dateProp(d: string | null) {
  return d ? { date: { start: d } } : { date: null };
}

export interface MirrorRow {
  vendorName: string;
  chplDeveloperId: string;
  certifiedCriteria: string[];
  segment: string | null;
  requestSent: string | null;
  verificationDue: string | null;
  verificationCompleted: string | null;
  productionDue: string | null;
  productionEnabled: string | null;
  clockStatus: string;
  blockingConcern: boolean;
  packetUrl: string | null;
  developerPortal: string | null;
  termsUrl: string | null;
  contactEmail: string | null;
  notionPageId: string | null;
}

/**
 * Create or update the tracker row for one request.
 * Returns the Notion page id so it can be stored back against the request.
 */
export async function mirrorRequest(row: MirrorRow): Promise<string | null> {
  if (!notionConfigured()) return row.notionPageId;

  // Only criteria the tracker knows about; an unknown select option is rejected.
  const criteriaTags = row.certifiedCriteria
    .map((c) => c.match(/\(g\)\((\d+)\)/)?.[1])
    .filter((n): n is string => n === '10' || n === '31' || n === '33')
    .map((n) => ({ name: `g${n}` }));

  const properties: Record<string, unknown> = {
    Vendor: { title: [{ text: { content: row.vendorName } }] },
    'CHPL Developer ID': { rich_text: [{ text: { content: row.chplDeveloperId } }] },
    'Certified Criteria': { multi_select: criteriaTags },
    'Request Sent': dateProp(row.requestSent),
    'Verification Due': dateProp(row.verificationDue),
    'Verification Completed': dateProp(row.verificationCompleted),
    'Production Due': dateProp(row.productionDue),
    'Production Enabled': dateProp(row.productionEnabled),
    'Clock Status': { select: { name: row.clockStatus } },
  };

  if (row.segment) properties.Segment = { select: { name: row.segment } };
  if (row.packetUrl) properties.Packet = { url: row.packetUrl };
  if (row.developerPortal) properties['Developer Portal'] = { url: row.developerPortal };
  if (row.termsUrl) properties['Terms URL'] = { url: row.termsUrl };
  if (row.contactEmail) properties.Contact = { email: row.contactEmail };

  // Only ever raise the flag. A human who ticked it by hand knows something
  // the clock job does not, and a sync should not quietly clear that.
  if (row.blockingConcern) properties['Blocking Concern'] = { checkbox: true };

  if (row.notionPageId) {
    await notion(`/pages/${row.notionPageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    return row.notionPageId;
  }

  const created = (await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATA_SOURCE_ID },
      properties,
    }),
  })) as { id: string };

  return created.id;
}
