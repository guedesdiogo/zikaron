const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** A real calendar date: `2026-02-30` isn't, though `Date.parse` rolls it over to March. */
function isCalendarDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

export function isDate(value: string): boolean {
  return DATE.test(value) && isCalendarDate(value);
}

export function isDateTime(value: string): boolean {
  const date = DATE_TIME.exec(value)?.[1];
  return date !== undefined && isCalendarDate(date);
}

/**
 * The instant a date names, in epoch milliseconds: `YYYY-MM-DD` is the start of that day in UTC,
 * and a date-time needs its offset. Null for anything else.
 */
export function instantOf(value: string): number | null {
  if (isDate(value)) return Date.parse(`${value}T00:00:00Z`);
  if (isDateTime(value)) return Date.parse(value);
  return null;
}
