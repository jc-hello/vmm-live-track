// Client for a raceresult.com live page: URLs, split config and the LiveRank list.
// Shared by the Worker, the browser pages and the scripts.
import type { RaceConfig, RaceResultConfig } from './race';

export type RawRow = unknown[];

export interface LiveListResponse {
  data?: unknown[];
  DataFields?: string[];
}

export interface SplitConfigResponse {
  splits?: { Contest: number; Name: string; Label?: string }[];
}

/** One runner on the live list. */
export interface LiveRunner {
  bib: string;
  rrId: string;
  name: string;
  club: string;
  nat: string;
  rank: number | null;
  rankText: string;
  gap: string;
  gRank: number | null;
  /** Raw gender/age-group rank text, e.g. "3. M | M40 | Div. rank: 1". */
  genderText: string;
  gender: string | null;
  ageGroup: string | null;
  aRank: number | null;
  /** Split name of the last checkpoint passed, "Finish" when finished, null before the first CP. */
  split: string | null;
  splitLabel: string | null;
  /** Time of day at the last checkpoint, "HH:MM:SS". */
  tod: string | null;
  /** Race time at the last checkpoint, seconds. */
  elapsed: number | null;
  finished: 0 | 1;
  /** Label of the next checkpoint. */
  next: string;
}

/** label or split name -> split name, per contest */
export type SplitMaps = Record<number, Record<string, string>>;

export type ColumnMap = Partial<Record<keyof typeof COLS | 'bib' | 'rrId', number>>;

const base = (rr: RaceResultConfig) => `${rr.server}/${rr.eventId}/live`;

export const listUrl = (rr: RaceResultConfig, contest: number) =>
  `${base(rr)}/list?key=${rr.key}&listname=${encodeURIComponent(rr.listName)}&page=live&contest=${contest}&r=all&l=0&openedGroups=%7B%7D&term=`;

export const configUrl = (rr: RaceResultConfig) => `${base(rr)}/config?key=${rr.key}&page=live`;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url.split('?')[0]}`);
  return (await r.json()) as T;
}

/** "H:MM:SS", "MM:SS" or "SS" -> seconds */
export function parseDuration(t: string): number | null {
  const p = String(t).trim().split(':').map(Number);
  if (!p.length || p.some(Number.isNaN)) return null;
  const [a = 0, b = 0, c = 0] = p;
  return p.length === 3 ? a * 3600 + b * 60 + c : p.length === 2 ? a * 60 + b : a;
}

const ordinal = (s: string) => {
  const m = /^(\d+)/.exec(s || '');
  return m ? +m[1]! : null;
};

export function splitMaps(config: SplitConfigResponse, aliases: Record<string, string> = {}): SplitMaps {
  const maps: SplitMaps = {};
  for (const s of config.splits ?? []) {
    const m = (maps[s.Contest] ||= { ...aliases });
    m[s.Name] = s.Name;
    if (s.Label) m[s.Label] = s.Name;
  }
  return maps;
}

export const labelMapFor = (maps: SplitMaps, contest: number, race: Pick<RaceConfig, 'labelAliases'>) =>
  maps[contest] ?? { ...race.labelAliases };

// Columns are found by their DataFields expression rather than by index: organisers
// change list layouts mid-race (VMM 2026 split "BIB - Name" and dropped CLUB at 10:50).
const COLS = {
  rank: /OverallRankLive/,
  gender: /GenderRankLive/,
  name: /DisplayName/,
  club: /\[CLUB\]/,
  nat: /NATION\.ALPHA3/,
  last: /"Arrived at "/,
  next: /"Next: "/,
  total: /"Total time to "/,
  gap: /Diff \/ 1st/,
};
const DEFAULT_LAYOUT: ColumnMap = { bib: 0, rrId: 1, rank: 2, gender: 3, name: 4, club: 5, nat: 6, last: 8, next: 9, total: 10, gap: 11 };

export function columnMap(dataFields?: string[] | null): ColumnMap {
  if (!Array.isArray(dataFields)) return DEFAULT_LAYOUT;
  const m: ColumnMap = { bib: 0, rrId: 1 };
  for (const [k, re] of Object.entries(COLS) as [keyof typeof COLS, RegExp][]) {
    const i = dataFields.findIndex(f => re.test(f));
    if (i >= 0) m[k] = i;
  }
  return m;
}

/** Rows of the live list that are runners (the list also has group header rows). */
export const runnerRows = (j: LiveListResponse): RawRow[] =>
  (j.data ?? []).filter((r): r is RawRow => Array.isArray(r) && r.length > 10);

/** One row of the LiveRank list -> flat record. `labelMap` maps a CP label to its split name. */
export function parseRow(r: RawRow, labelMap: Record<string, string> = {}, cols: ColumnMap = DEFAULT_LAYOUT): LiveRunner {
  const at = (k: keyof ColumnMap) => {
    const i = cols[k];
    return i != null ? String(r[i] ?? '') : '';
  };
  const genderText = at('gender'), last = at('last'), total = at('total'), rankText = at('rank');
  const o: LiveRunner = {
    bib: at('bib'),
    rrId: at('rrId'),
    name: at('name').replace(/^\d+\s*-\s*/, ''),
    club: at('club'),
    nat: at('nat'),
    rank: ordinal(rankText),
    rankText,
    gap: at('gap').replace('Diff / 1st: ', ''),
    gRank: ordinal(genderText),
    genderText,
    gender: null,
    ageGroup: null,
    aRank: null,
    split: null,
    splitLabel: null,
    tod: null,
    elapsed: null,
    finished: 0,
    next: at('next').replace('Next: ', ''),
  };
  const g = /^\d+\w*\s+(\w+)(?:\s*\|\s*(.+?)\s*\|\s*Div\. rank:\s*(\d+))?/.exec(genderText);
  if (g) {
    o.gender = g[1] ?? null;
    o.ageGroup = g[2] ?? null;
    o.aRank = g[3] ? +g[3] : null;
  }
  const arrived = /^Arrived at (.+) at (\d+:\d+:\d+)$/.exec(last);
  const totalTime = /: ([\d:]+)$/.exec(total);
  if (/^Time: \S/.test(last)) {
    o.finished = 1;
    o.split = o.splitLabel = 'Finish';
    o.elapsed = parseDuration(last.slice(6));
  } else if (arrived) {
    o.splitLabel = arrived[1]!;
    o.split = labelMap[arrived[1]!] ?? arrived[1]!;
    o.tod = arrived[2]!;
    o.elapsed = totalTime ? parseDuration(totalTime[1]!) : null;
  }
  return o;
}

/** Fetch and parse one contest's live list. */
export async function fetchLiveList(rr: RaceResultConfig, contest: number, labelMap: Record<string, string>, init?: RequestInit) {
  const j = await fetchJson<LiveListResponse>(listUrl(rr, contest), init);
  const cols = columnMap(j.DataFields);
  return runnerRows(j).map(r => parseRow(r, labelMap, cols));
}
