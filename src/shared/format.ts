// Formatting helpers shared by the pages and the email alerts.

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** seconds -> "H:MM:SS" */
export const hms = (s: number | null | undefined) => {
  if (s == null || !isFinite(s)) return '–';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};

/** seconds -> "7h05" */
export const hm = (s: number | null | undefined) => (s == null || !isFinite(s) ? '–' : `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}`);

/** minutes -> "m:ss" */
export const mmss = (m: number | null | undefined) => (m == null || !isFinite(m) ? '–' : `${Math.floor(m)}:${pad2(Math.round((m % 1) * 60))}`);

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Clock formatters bound to the race's time zone and locale. */
export function clocks(timeZone: string, locale = 'en-GB') {
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayTime = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const num = new Intl.NumberFormat(locale);
  return {
    /** "14:05" */
    time: (ms: number) => time.format(ms),
    /** "Fri 14:05" */
    dayTime: (ms: number) => dayTime.format(ms),
    num: (n: number) => num.format(n),
  };
}

/** Last two words of a name, for tight spaces. */
export const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 2 ? parts.slice(-2).join(' ') : name;
};
