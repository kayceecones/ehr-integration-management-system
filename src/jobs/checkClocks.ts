/**
 * Daily job: re-classify every open access request against its deadlines.
 *
 * Runs on a schedule. Statuses are stored rather than computed on read so that
 * the API, the Notion mirror, and any complaint draft all quote the same
 * numbers -- three surfaces disagreeing about whether a vendor is late is
 * exactly the kind of thing that undermines an escalation.
 */

import { listRequests, updateClock } from '../db/client.ts';
import { classifyClock, verificationDue, productionDue } from '../lib/businessDays.ts';

export interface ClockRunResult {
  checked: number;
  overdue: { vendor: string; stage: string; days: number; citation: string }[];
  dueSoon: { vendor: string; stage: string; days: number }[];
}

export async function checkClocks(today?: string): Promise<ClockRunResult> {
  const requests = await listRequests();
  const result: ClockRunResult = { checked: 0, overdue: [], dueSoon: [] };

  for (const r of requests) {
    const c = classifyClock({
      requestSent: r.request_sent,
      verificationCompleted: r.verification_completed,
      productionEnabled: r.production_enabled,
      today,
    });

    // Both deadlines are computed whenever their inputs exist, not only while
    // that stage is the active one. A deadline that has already been met is
    // still the record of what the vendor was obliged to do and when -- it is
    // what an escalation or an audit would be reconstructed from, so it is
    // stored rather than discarded once the stage moves on.
    await updateClock(r.id, {
      verificationDue: r.request_sent ? verificationDue(r.request_sent) : null,
      productionDue: r.verification_completed ? productionDue(r.verification_completed) : null,
      clockStatus: c.status,
      businessDaysRemaining: c.businessDaysRemaining,
      // A missed statutory deadline is itself the blocking concern.
      blockingConcern: c.breach !== null,
      blockingNote: c.breach
        ? `${c.breach.citation}: ${c.breach.stage} deadline of ${c.breach.deadline} passed ` +
          `${c.breach.businessDaysOverdue} business day(s) ago.`
        : null,
    });

    result.checked += 1;
    const vendor = r.vendor_name ?? `vendor ${r.vendor_id}`;
    if (c.breach) {
      result.overdue.push({
        vendor, stage: c.breach.stage,
        days: c.breach.businessDaysOverdue, citation: c.breach.citation,
      });
    } else if (c.status === 'due soon' && c.activeStage) {
      result.dueSoon.push({ vendor, stage: c.activeStage, days: c.businessDaysRemaining ?? 0 });
    }
  }

  return result;
}

// Direct invocation: `node --experimental-strip-types src/jobs/checkClocks.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  checkClocks()
    .then((r) => {
      console.log(`Checked ${r.checked} request(s).`);
      for (const o of r.overdue) {
        console.log(`  OVERDUE  ${o.vendor} — ${o.stage} ${o.days}bd late (${o.citation})`);
      }
      for (const d of r.dueSoon) {
        console.log(`  DUE SOON ${d.vendor} — ${d.stage} in ${d.days}bd`);
      }
      if (!r.overdue.length && !r.dueSoon.length) console.log('  Nothing needs attention.');
      process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
