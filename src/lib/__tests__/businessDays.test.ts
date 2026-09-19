import {
  federalHolidays, isBusinessDay, addBusinessDays, businessDaysBetween,
  verificationDue, productionDue, classifyClock,
} from '../businessDays.ts';

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

// 2026 holidays, spot-checked against the OPM calendar.
const h26 = federalHolidays(2026);
check('2026-01-01 New Years (Thu)', h26.has('2026-01-01'), true);
check('2026-01-19 MLK 3rd Mon Jan', h26.has('2026-01-19'), true);
check('2026-02-16 Washington 3rd Mon Feb', h26.has('2026-02-16'), true);
check('2026-05-25 Memorial last Mon May', h26.has('2026-05-25'), true);
check('2026-06-19 Juneteenth (Fri)', h26.has('2026-06-19'), true);
check('2026-07-03 July 4 falls Sat -> observed Fri', h26.has('2026-07-03'), true);
check('2026-07-04 itself not observed', h26.has('2026-07-04'), false);
check('2026-09-07 Labor 1st Mon Sep', h26.has('2026-09-07'), true);
check('2026-10-12 Columbus 2nd Mon Oct', h26.has('2026-10-12'), true);
check('2026-11-11 Veterans (Wed)', h26.has('2026-11-11'), true);
check('2026-11-26 Thanksgiving 4th Thu Nov', h26.has('2026-11-26'), true);
check('2026-12-25 Christmas (Fri)', h26.has('2026-12-25'), true);
check('exactly 11 holidays in 2026', h26.size, 11);

// 2027-01-01 is a Friday, so no cross-year shift; 2022-01-01 was a Saturday
// observed on 2021-12-31. That is the case the isHoliday() next-year lookup exists for.
check('2021-12-31 observed New Years', isBusinessDay('2021-12-31'), false);

// Weekends
check('2026-09-19 Saturday', isBusinessDay('2026-09-19'), false);
check('2026-09-20 Sunday', isBusinessDay('2026-09-20'), false);
check('2026-09-21 Monday', isBusinessDay('2026-09-21'), true);

// addBusinessDays: start not counted.
check('Mon +1 = Tue', addBusinessDays('2026-09-21', 1), '2026-09-22');
check('Fri +1 = Mon', addBusinessDays('2026-09-18', 1), '2026-09-21');
check('Mon +5 = next Mon', addBusinessDays('2026-09-21', 5), '2026-09-28');
check('+0 is identity', addBusinessDays('2026-09-21', 0), '2026-09-21');

// The real deadline: request received Mon 2026-09-21, +10 business days.
// Sep 22,23,24,25,28,29,30, Oct 1,2,5 -> 2026-10-05
check('verificationDue from 2026-09-21', verificationDue('2026-09-21'), '2026-10-05');

// Spanning Thanksgiving: Mon 2026-11-23 +5 business days.
// Nov 24,25,27(26 is Thanksgiving),30, Dec 1 -> 2026-12-01
check('productionDue spans Thanksgiving', productionDue('2026-11-23'), '2026-12-01');

// Spanning the observed July 4: Mon 2026-06-29 +5.
// Jun 30, Jul 1,2,6 (3 observed holiday, 4-5 weekend), 7 -> 2026-07-07
check('productionDue spans observed Jul 4', productionDue('2026-06-29'), '2026-07-07');

check('businessDaysBetween fwd', businessDaysBetween('2026-09-21', '2026-09-28'), 5);
check('businessDaysBetween back', businessDaysBetween('2026-09-28', '2026-09-21'), -5);
check('businessDaysBetween same', businessDaysBetween('2026-09-21', '2026-09-21'), 0);

// Classifier
check('no request = not started',
  classifyClock({ today: '2026-09-21' }).status, 'not started');
check('enabled = complete',
  classifyClock({ requestSent: '2026-09-01', productionEnabled: '2026-09-15', today: '2026-09-21' }).status, 'complete');

const onTime = classifyClock({ requestSent: '2026-09-21', today: '2026-09-22' });
check('fresh request on time', onTime.status, 'on time');
check('fresh request stage', onTime.activeStage, 'verification');
check('fresh request deadline', onTime.activeDeadline, '2026-10-05');

check('2 days left = due soon',
  classifyClock({ requestSent: '2026-09-21', today: '2026-10-01' }).status, 'due soon');

const late = classifyClock({ requestSent: '2026-09-21', today: '2026-10-08' });
check('past deadline = overdue', late.status, 'overdue');
check('overdue cites (b)(1)(i)', late.breach?.citation, '45 CFR 170.404(b)(1)(i)');
check('overdue by 3 business days', late.breach?.businessDaysOverdue, 3);

const prod = classifyClock({ requestSent: '2026-09-01', verificationCompleted: '2026-09-21', today: '2026-09-22' });
check('verified moves to production stage', prod.activeStage, 'production');
check('production deadline', prod.activeDeadline, '2026-09-28');

// A vendor that skipped verification and went straight to enabling us has not breached.
check('enabled without verification = complete',
  classifyClock({ requestSent: '2026-01-01', productionEnabled: '2026-09-01', today: '2026-09-21' }).status, 'complete');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
