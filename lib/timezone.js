export const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'Africa/Lagos';

/**
 * Parses a local datetime string (e.g. "2026-10-02T14:30") within the given timezone
 * and converts it to a standard JavaScript Date object (UTC instant).
 * If the string already includes timezone info (e.g. "Z" or "+01:00"), it parses directly.
 */
export function parseLocalDateTimeInTz(str, tz = DEFAULT_TIMEZONE) {
  if (!str) return null;
  if (str instanceof Date) return str;
  if (typeof str !== 'string') return new Date(str);
  const trimmed = str.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return new Date(trimmed);
  }
  const [dPart, tPart = '00:00'] = trimmed.split('T');
  const [y, m, d] = dPart.split('-').map(Number);
  const [h, min, s = 0] = tPart.split(':').map(Number);
  const utcBase = new Date(Date.UTC(y, m - 1, d, h, min, s));
  const utcDate = new Date(utcBase.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(utcBase.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = tzDate.getTime() - utcDate.getTime();
  return new Date(utcBase.getTime() - offsetMs);
}

/**
 * Formats a Date or timestamp as 'YYYY-MM-DD' in the given timezone.
 */
export function formatDateInTz(date, tz = DEFAULT_TIMEZONE) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Formats a Date or timestamp as 'HH:mm' in the given timezone.
 */
export function formatTimeInTz(date, tz = DEFAULT_TIMEZONE) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

/**
 * Formats date into "YYYY-MM-DDTHH:mm" for HTML datetime-local inputs in browser local time.
 */
export function toLocalDatetimeInputStr(date = new Date()) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Formats date into "YYYY-MM-DD" in browser local time.
 */
export function toLocalDateStr(date = new Date()) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
