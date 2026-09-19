/**
 * Business-day arithmetic for the 45 CFR 170.404(b)(1) clocks.
 *
 * The regulation gives a Certified API Developer ten business days to complete
 * authenticity verification of an API User, and five business days after that
 * to register and enable the application for production use. Those are business
 * days, not calendar days, so weekends and US federal holidays are excluded.
 *
 * If a date computed here ever appears in an information-blocking complaint it
 * has to be defensible. Holidays are derived from their statutory rules rather
 * than hardcoded per year, and observed-day shifts are applied: a fixed-date
 * holiday falling on Saturday is observed the preceding Friday, and one falling
 * on Sunday is observed the following Monday.
 *
 * Dates are handled as UTC calendar dates throughout. Callers pass and receive
 * YYYY-MM-DD strings; time of day is not meaningful for these deadlines.
 */

export type IsoDate = string; // YYYY-MM-DD

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUTC(date: IsoDate): Date {
  if (!ISO_DATE.test(date)) {
    throw new Error(`Expected a YYYY-MM-DD date, got: ${date}`);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  // Reject dates that look well-formed but are not real (2026-02-30 rolls
  // forward silently otherwise, and a deadline off by a day is the one bug
  // this module cannot afford).
  if (toIso(utc) !== date) throw new Error(`Not a real calendar date: ${date}`);
  return utc;
}

function toIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The nth given weekday of a month. weekday: 0=Sun .. 6=Sat. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

/** The last given weekday of a month. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

/**
 * The eleven US federal holidays for a year, as actually observed.
 *
 * Fixed-date holidays shift when they land on a weekend. Floating holidays
 * (defined as "the nth Monday in X") are already on a weekday and never shift.
 */
export function federalHolidays(year: number): Set<IsoDate> {
  const observed = (date: Date): Date => {
    const dow = date.getUTCDay();
    if (dow === 6) return addDays(date, -1); // Saturday -> preceding Friday
    if (dow === 0) return addDays(date, 1);  // Sunday -> following Monday
    return date;
  };

  const fixed = [
    new Date(Date.UTC(year, 0, 1)),   // New Year's Day
    new Date(Date.UTC(year, 5, 19)),  // Juneteenth National Independence Day
    new Date(Date.UTC(year, 6, 4)),   // Independence Day
    new Date(Date.UTC(year, 10, 11)), // Veterans Day
    new Date(Date.UTC(year, 11, 25)), // Christmas Day
  ].map(observed);

  const floating = [
    nthWeekdayOfMonth(year, 0, 1, 3),  // MLK Jr. Day - 3rd Monday in January
    nthWeekdayOfMonth(year, 1, 1, 3),  // Washington's Birthday - 3rd Monday in February
    lastWeekdayOfMonth(year, 4, 1),    // Memorial Day - last Monday in May
    nthWeekdayOfMonth(year, 8, 1, 1),  // Labor Day - 1st Monday in September
    nthWeekdayOfMonth(year, 9, 1, 2),  // Columbus Day - 2nd Monday in October
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving Day - 4th Thursday in November
  ];

  return new Set([...fixed, ...floating].map(toIso));
}

// A New Year's Day falling on a Saturday is observed on December 31 of the
// PRIOR year, so a December date must also consult the next year's holiday set.
const holidayCache = new Map<number, Set<IsoDate>>();

function holidaysFor(year: number): Set<IsoDate> {
  let cached = holidayCache.get(year);
  if (!cached) {
    cached = federalHolidays(year);
    holidayCache.set(year, cached);
  }
  return cached;
}

export function isHoliday(date: IsoDate): boolean {
  const year = Number(date.slice(0, 4));
  return holidaysFor(year).has(date) || holidaysFor(year + 1).has(date);
}

export function isBusinessDay(date: IsoDate): boolean {
  const dow = toUTC(date).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isHoliday(date);
}

/**
 * Add N business days to a date.
 *
 * The start date itself is not counted. "Within ten business days of receipt"
 * is read as the clock starting the next business day after receipt.
 */
export function addBusinessDays(start: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('addBusinessDays expects a non-negative integer count');
  }
  let cursor = toUTC(start);
  let remaining = n;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(toIso(cursor))) remaining -= 1;
  }
  return toIso(cursor);
}

/**
 * Business days between two dates: exclusive of `from`, inclusive of `to`.
 * Negative when `to` precedes `from`.
 */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  const start = toUTC(from);
  const end = toUTC(to);
  const forward = end >= start;
  let cursor = forward ? start : end;
  const target = forward ? end : start;
  let count = 0;
  while (cursor < target) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(toIso(cursor))) count += 1;
  }
  return forward ? count : -count;
}

// --- The two statutory deadlines -------------------------------------------

/** 45 CFR 170.404(b)(1)(i) - ten business days from receipt of our request. */
export const VERIFICATION_BUSINESS_DAYS = 10;

/** 45 CFR 170.404(b)(1)(ii) - five business days from completed verification. */
export const PRODUCTION_BUSINESS_DAYS = 5;

export const CITATIONS = {
  verification: '45 CFR 170.404(b)(1)(i)',
  production: '45 CFR 170.404(b)(1)(ii)',
} as const;

export function verificationDue(requestSent: IsoDate): IsoDate {
  return addBusinessDays(requestSent, VERIFICATION_BUSINESS_DAYS);
}

export function productionDue(verificationCompleted: IsoDate): IsoDate {
  return addBusinessDays(verificationCompleted, PRODUCTION_BUSINESS_DAYS);
}

export type ClockStatus = 'not started' | 'on time' | 'due soon' | 'overdue' | 'complete';
export type Stage = 'verification' | 'production';

export interface ClockInput {
  requestSent?: IsoDate | null;
  verificationCompleted?: IsoDate | null;
  productionEnabled?: IsoDate | null;
  /** Defaults to today; injectable so the classifier is testable. */
  today?: IsoDate;
}

export interface ClockResult {
  status: ClockStatus;
  /** The deadline currently in force, if any. */
  activeDeadline: IsoDate | null;
  /** Which obligation that deadline belongs to. */
  activeStage: Stage | null;
  /** Business days until the active deadline; negative once overdue. */
  businessDaysRemaining: number | null;
  /** Populated once a deadline has passed unmet. */
  breach: {
    stage: Stage;
    deadline: IsoDate;
    businessDaysOverdue: number;
    citation: string;
  } | null;
}

/** Two or fewer business days left means there is still time to chase. */
export const DUE_SOON_THRESHOLD = 2;

/**
 * Classify where a request stands against its deadlines.
 *
 * Note the ordering: production enablement is checked first, because a request
 * that reached production is complete regardless of whether verification was
 * ever recorded. A vendor that skips straight to enabling us has not breached
 * anything.
 */
export function classifyClock(input: ClockInput): ClockResult {
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  const empty: ClockResult = {
    status: 'not started',
    activeDeadline: null,
    activeStage: null,
    businessDaysRemaining: null,
    breach: null,
  };

  if (input.productionEnabled) return { ...empty, status: 'complete' };
  if (!input.requestSent) return empty;

  const stage: Stage = input.verificationCompleted ? 'production' : 'verification';
  const deadline = input.verificationCompleted
    ? productionDue(input.verificationCompleted)
    : verificationDue(input.requestSent);
  const remaining = businessDaysBetween(today, deadline);

  if (remaining < 0) {
    return {
      status: 'overdue',
      activeDeadline: deadline,
      activeStage: stage,
      businessDaysRemaining: remaining,
      breach: {
        stage,
        deadline,
        businessDaysOverdue: Math.abs(remaining),
        citation: CITATIONS[stage],
      },
    };
  }

  return {
    status: remaining <= DUE_SOON_THRESHOLD ? 'due soon' : 'on time',
    activeDeadline: deadline,
    activeStage: stage,
    businessDaysRemaining: remaining,
    breach: null,
  };
}
