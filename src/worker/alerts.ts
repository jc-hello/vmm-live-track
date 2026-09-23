// Email alerts for followed runners and for the logger's own health, sent through Resend.
// Runs inside the Poller Durable Object after every poll; state lives in DO storage.
import type { Env } from './env';
import { loadRace, loadTrack } from './race';
import { nextEta } from '../shared/estimate';
import { clocks, escapeHtml as esc, hms } from '../shared/format';
import type { Track } from '../shared/race';
import type { LiveRunner } from '../shared/raceresult';

const FAIL_ALERT_AFTER = 6; // consecutive failed polls (~3 min) before alerting
const MISSING_AFTER = 3; // polls absent from the live list before alerting
const MIN_FIELD_FOR_STATS = 10; // runners with a segment time before comparing against them

interface RunnerWatch {
  lastSplit?: string | null;
  lastLabel?: string;
  lastElapsed?: number | null;
  lastRank?: number | null;
  missing?: number;
  missingAlerted?: boolean;
  overdueFor?: string | null;
  overdueLevel?: number;
}

export interface WatchState {
  failStreak?: number;
  failAlerted?: boolean;
  lastErr?: string;
  lastMail?: string;
  lastMailErr?: string;
  runners?: Record<string, RunnerWatch>;
}

type Row = [label: string, htmlValue: string];
type Mail = [subject: string, rows: Row[], idempotencyKey: string];

export const alertsEnabled = (env: Env) => !!(env.RESEND_API_KEY && env.ALERT_FROM && env.ALERT_TO && env.WATCH_BIBS);

const watchedBibs = (env: Env) => (env.WATCH_BIBS || '').split(',').map(s => s.trim()).filter(Boolean);

async function send(env: Env, raceName: string, bib: string | null, subject: string, rows: Row[], idemKey: string) {
  const site = env.SITE_URL?.replace(/\/$/, '');
  const links = site && bib
    ? `<p style="margin:16px 0 0"><a href="${site}/?bib=${encodeURIComponent(bib)}" style="color:#e4501b">Map</a> · <a href="${site}/analytics.html?bib=${encodeURIComponent(bib)}" style="color:#e4501b">Analytics</a></p>`
    : '';
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#111">
    <h2 style="margin:0 0 12px;font-size:18px">${esc(subject)}</h2>
    <table style="border-collapse:collapse;font-size:14px;width:100%">${rows
      .map(([k, v]) => `<tr><td style="padding:6px 10px 6px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
      .join('')}</table>${links}
    <p style="color:#999;font-size:12px;margin-top:16px">${esc(raceName)} live tracker</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': idemKey },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO!.split(',').map(s => s.trim()), subject, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** How this runner's last segment compares with everyone else's on the same segment. */
async function segmentStats(env: Env, contest: number, from: string, to: string, mine: number | null) {
  const { results } = await env.DB.prepare('SELECT bib, split, elapsed FROM passings WHERE contest=? AND split IN (?,?)')
    .bind(contest, from, to)
    .all<{ bib: string; split: string; elapsed: number | null }>();
  const t: Record<string, Record<string, number | null>> = {};
  for (const r of results) (t[r.bib] ||= {})[r.split] = r.elapsed;
  const segs = Object.values(t)
    .filter(x => x[from] != null && x[to] != null)
    .map(x => x[to]! - x[from]!)
    .sort((a, b) => a - b);
  if (segs.length < MIN_FIELD_FOR_STATS || mine == null) return null;
  const med = segs[Math.floor(segs.length / 2)]!;
  const faster = segs.filter(x => x > mine).length;
  return { n: segs.length, med, pct: Math.round((faster / (segs.length - 1)) * 100) };
}

const rankRows = (o: LiveRunner): Row[] => [
  ['Rank', `${o.rank ?? '–'} overall · ${o.gRank ?? '–'} ${esc(o.gender || '')}${o.aRank ? ` · ${o.aRank} ${esc(o.ageGroup)}` : ''}`],
  ['Behind leader', esc(o.gap || '–')],
];

const lateText = (min: number) => `${Math.floor(min / 60) ? Math.floor(min / 60) + 'h ' : ''}${min % 60} min`;

async function runnerMails(env: Env, track: Track, bib: string, R: RunnerWatch, recs: LiveRunner[], now: number): Promise<Mail[]> {
  const out: Mail[] = [];
  const race = await loadRace(env);
  const { dayTime } = clocks(race.timezone, race.locale);
  const cpIdx = (k: string | null | undefined) => (k ? track.cps.findIndex(c => c.key === k) : -1);
  const o = recs.find(r => r.bib === bib);

  if (!o) {
    R.missing = (R.missing || 0) + 1;
    if (R.missing >= MISSING_AFTER && !R.missingAlerted && recs.length > 0) {
      out.push([
        `🚨 Bib ${bib} is no longer on the live list`,
        [
          ['Last checkpoint', esc(R.lastLabel || '–')],
          ['Race time', hms(R.lastElapsed)],
          ['What it means', 'raceresult only lists runners who are still racing: the runner may have DNF’d, withdrawn or had their status changed. Contact them directly to check.'],
          ['At', dayTime(now)],
        ],
        `missing-${bib}-${R.lastSplit}`,
      ]);
      R.missingAlerted = true;
    }
    return out;
  }

  if (R.missingAlerted) out.push([`ℹ️ ${o.name} is back on the live list`, [['Checkpoint', esc(o.splitLabel || '–')], ...rankRows(o)], `back-${bib}-${now}`]);
  R.missing = 0;
  R.missingAlerted = false;

  const first = R.lastSplit === undefined;
  if (o.split && o.split !== R.lastSplit) {
    const i = cpIdx(o.split);
    const cur = track.cps[i] ?? { label: o.splitLabel ?? o.split, km: NaN, key: o.split };
    const prevCp = i > 0 ? track.cps[i - 1] : undefined;
    const ranPrevSegment = !!prevCp && R.lastSplit === prevCp.key && o.elapsed != null && R.lastElapsed != null;
    const segT = ranPrevSegment ? o.elapsed! - R.lastElapsed! : null;
    const seg = prevCp ? await segmentStats(env, track.contest.id, prevCp.key, o.split, segT) : null;
    const eta = nextEta(track, o.split, o.elapsed);
    const rows: Row[] = [
      ['Arrived', `${o.tod || '–'} · race time ${hms(o.elapsed)}`],
      ['Distance', `km ${isNaN(cur.km) ? '?' : cur.km} / ${track.route.totalKm}`],
      ...rankRows(o),
    ];
    if (R.lastRank && o.rank) {
      const d = R.lastRank - o.rank;
      rows.push(['Rank change', `${d >= 0 ? '▲ +' : '▼ '}${d} since ${esc(R.lastLabel)}`]);
    }
    if (ranPrevSegment) {
      rows.push([
        'Last segment',
        `${esc(prevCp!.label)} → ${esc(cur.label)}: ${hms(segT)}${seg ? ` (median ${hms(seg.med)}, faster than ${seg.pct}% of ${seg.n} runners)` : ''}`,
      ]);
    } else if (R.lastSplit && i - cpIdx(R.lastSplit) > 1) {
      rows.push(['Note', 'A checkpoint was skipped between two readings (chip not read, or the timing system has not caught up yet).']);
    }
    if (o.finished) rows.push(['Finished', `🏁 ${hms(o.elapsed)}`]);
    else if (eta) rows.push(['Next checkpoint', `${esc(eta.next.label)} (km ${eta.next.km}, +${(eta.next.km - eta.cp.km).toFixed(1)} km) · expected ~${dayTime(eta.etaMs)}`]);
    const subject = first
      ? `▶️ Now following ${o.name}: ${cur.label}, rank ${o.rank}`
      : o.finished
        ? `🏁 ${o.name} finished: ${hms(o.elapsed)}, rank ${o.rank}`
        : `✅ ${o.name} passed ${cur.label} at ${(o.tod || '').slice(0, 5)} · rank ${o.rank}`;
    out.push([subject, rows, `cp-${bib}-${o.split}${first ? '-init' : ''}`]);
    Object.assign(R, { lastSplit: o.split, lastLabel: cur.label, lastElapsed: o.elapsed, lastRank: o.rank, overdueFor: null, overdueLevel: 0 });
  }

  // Overdue: no new checkpoint well past the expected arrival.
  // Level 1 at max(45 min, 30% of the segment) past the ETA, level 2 at 2 h past it.
  const eta = !o.finished ? nextEta(track, o.split, o.elapsed) : null;
  const level = R.overdueFor === o.split ? R.overdueLevel || 1 : 0;
  if (eta && level < 2) {
    const grace = Math.max(45 * 60, eta.segSec * 0.3) * 1000;
    const lateMin = Math.round((now - eta.etaMs) / 60000);
    const hit = level === 0 ? now > eta.etaMs + grace : now > eta.etaMs + Math.max(grace + 30 * 60000, 2 * 3600000);
    if (hit) {
      out.push([
        `${level === 0 ? '⚠️' : '🚨'} ${o.name} ${level === 0 ? 'has not reached' : 'STILL has not reached'} ${eta.next.label}, ${lateText(lateMin)} later than expected`,
        [
          ['Last checkpoint', `${esc(R.lastLabel)} at ${o.tod || '–'} (race time ${hms(o.elapsed)})`],
          ['Expected at', `${esc(eta.next.label)} ~${dayTime(eta.etaMs)}`],
          ['This segment', `${(eta.next.km - eta.cp.km).toFixed(1)} km, expected ${hms(eta.segSec)}`],
          ['Note', 'The runner may be resting at an aid station, slowing down from fatigue or weather, or the chip was not read. This is not necessarily an incident.'],
          ['No signal since', `${dayTime(track.startMs + (o.elapsed ?? 0) * 1000)} (${hms((now - track.startMs) / 1000 - (o.elapsed ?? 0))} ago)`],
        ],
        `overdue-${bib}-${o.split}-${level + 1}`,
      ]);
      R.overdueFor = o.split;
      R.overdueLevel = level + 1;
    }
  }
  return out;
}

let cached: WatchState | null = null; // DO memory copy; storage is written only when the state changes

export async function watch(env: Env, storage: DurableObjectStorage, contest: number, recs: LiveRunner[] | null, pollOk: boolean, lastErr?: string) {
  const S: WatchState = cached || (await storage.get<WatchState>('watch')) || {};
  S.runners ||= {};
  const before = JSON.stringify(S);
  const race = await loadRace(env);
  const { dayTime } = clocks(race.timezone, race.locale);
  const now = Date.now();
  const out: [bib: string | null, ...Mail][] = [];

  // ---- logger health ----
  if (!pollOk) {
    S.lastErr = lastErr;
    S.failStreak = (S.failStreak || 0) + 1;
    if (S.failStreak >= FAIL_ALERT_AFTER && !S.failAlerted) {
      out.push([null, '🔴 Logger: polls keep failing', [['Consecutive failures', String(S.failStreak)], ['Last error', esc(S.lastErr || '–')], ['At', dayTime(now)]], `fail-${Math.floor(now / 60000)}`]);
      S.failAlerted = true;
    }
  } else {
    if (S.failAlerted) out.push([null, '🟢 Logger: back to normal', [['Outage', `${S.failStreak} polls`], ['At', dayTime(now)]], `recover-${Math.floor(now / 60000)}`]);
    S.failStreak = 0;
    S.failAlerted = false;
  }

  // ---- followed runners ----
  if (pollOk && recs) {
    const track = await loadTrack(env, contest);
    for (const bib of watchedBibs(env)) for (const m of await runnerMails(env, track, bib, (S.runners[bib] ||= {}), recs, now)) out.push([bib, ...m]);
  }

  for (const [bib, subject, rows, key] of out) {
    try {
      await send(env, race.name, bib, subject, rows, key);
      S.lastMail = `${new Date(now).toISOString()} ${subject}`;
    } catch (e) {
      S.lastMailErr = `${new Date(now).toISOString()} ${(e as Error).message}`;
    }
  }
  if (JSON.stringify(S) !== before) await storage.put('watch', S);
  cached = S;
  return S;
}
