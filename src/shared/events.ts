// Turns successive live-list polls into events and SQL statements.
// Used by the logger Worker and by scripts/backfill.ts, so both write identical rows.
import type { LiveRunner } from './raceresult';

export type RunnerStatus = 'running' | 'missing';

export interface RunnerState {
  split: string | null;
  status: RunnerStatus;
  finished: 0 | 1;
  elapsed: number | null;
}

/** bib -> last known state */
export type ContestState = Record<string, RunnerState>;

export interface PollEvents {
  added: LiveRunner[];
  updated: LiveRunner[];
  passed: LiveRunner[];
  corrected: LiveRunner[];
  missing: string[];
}

/** The subset of D1Database the statements need (lets scripts render SQL offline). */
export interface SqlDb<S> {
  prepare(sql: string): { bind(...values: unknown[]): S };
}

/** Skip "missing" detection when a poll returns fewer than this share of running runners. */
export const TRUNCATED_LIST_RATIO = 0.7;

/** What changed between the stored state and one poll. */
export function diffEvents(recs: LiveRunner[], state: ContestState): PollEvents {
  const ev: PollEvents = { added: [], updated: [], passed: [], corrected: [], missing: [] };
  const seen = new Set<string>();
  for (const o of recs) {
    seen.add(o.bib);
    const prev = state[o.bib];
    if (!prev) ev.added.push(o);
    else if (prev.split !== o.split || prev.status !== 'running' || prev.finished !== o.finished) ev.updated.push(o);
    if (o.split && o.elapsed != null && (!prev || prev.split !== o.split)) ev.passed.push(o);
    // raceresult re-times a CP ~20 s later (second mat read); keep the latest official value
    else if (prev && o.split && prev.split === o.split && o.elapsed != null && prev.elapsed != null && prev.elapsed !== o.elapsed)
      ev.corrected.push(o);
  }
  // Runners that dropped off the live list (DNF / DSQ / status change).
  // Skip when the list looks truncated so a bad fetch can't mark everyone missing.
  const running = Object.values(state).filter(s => s.status === 'running' && !s.finished).length;
  if (recs.length >= running * TRUNCATED_LIST_RATIO)
    for (const [bib, s] of Object.entries(state)) if (!seen.has(bib) && s.status === 'running' && !s.finished) ev.missing.push(bib);
  return ev;
}

export function eventStatements<S>(db: SqlDb<S>, contest: number, ev: PollEvents, ts: string): S[] {
  const out: S[] = [];
  for (const o of ev.added)
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO runners (contest,bib,rr_id,name,club,nat,gender,age_group,first_seen,last_seen,status,last_split,last_elapsed,finished)
           VALUES (?,?,?,?,?,?,?,?,?,?,'running',?,?,?)`,
        )
        .bind(contest, o.bib, o.rrId, o.name, o.club, o.nat, o.gender, o.ageGroup, ts, ts, o.split, o.elapsed, o.finished),
    );
  for (const o of ev.updated)
    out.push(
      db
        .prepare(`UPDATE runners SET last_seen=?, status='running', last_split=?, last_elapsed=?, finished=? WHERE contest=? AND bib=?`)
        .bind(ts, o.split, o.elapsed, o.finished, contest, o.bib),
    );
  for (const o of ev.passed)
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO passings (contest,bib,split,label,tod,elapsed,rank_overall,rank_gender,rank_age,gap,observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(contest, o.bib, o.split, o.splitLabel, o.tod, o.elapsed, o.rank, o.gRank, o.aRank, o.gap, ts),
    );
  for (const o of ev.corrected) {
    out.push(
      db
        .prepare('UPDATE passings SET elapsed=?, tod=?, rank_overall=?, rank_gender=?, gap=? WHERE contest=? AND bib=? AND split=?')
        .bind(o.elapsed, o.tod, o.rank, o.gRank, o.gap, contest, o.bib, o.split),
    );
    out.push(db.prepare('UPDATE runners SET last_elapsed=? WHERE contest=? AND bib=?').bind(o.elapsed, contest, o.bib));
  }
  for (const bib of ev.missing)
    out.push(db.prepare(`UPDATE runners SET status='missing', missing_since=? WHERE contest=? AND bib=?`).bind(ts, contest, bib));
  return out;
}

/** Advance the in-memory state exactly as the statements advance the database. */
export function applyEvents(state: ContestState, ev: PollEvents) {
  for (const o of [...ev.added, ...ev.updated]) state[o.bib] = { split: o.split, status: 'running', finished: o.finished, elapsed: o.elapsed };
  for (const o of ev.corrected) state[o.bib] = { ...state[o.bib]!, elapsed: o.elapsed };
  for (const bib of ev.missing) state[bib] = { ...state[bib]!, status: 'missing' };
}

export const snapshotStatement = <S>(db: SqlDb<S>, ts: string, contest: number, recs: LiveRunner[]) =>
  db.prepare('INSERT OR IGNORE INTO snapshots (ts,contest,n,data) VALUES (?,?,?,?)').bind(ts, contest, recs.length, snapshotData(recs));

/** Compact per-poll snapshot: [bib, rank, genderRank, split, elapsed] */
export const snapshotData = (recs: LiveRunner[]) => JSON.stringify(recs.map(o => [o.bib, o.rank, o.gRank, o.split, o.elapsed]));

/** ISO timestamp truncated to seconds, as stored in every table. */
export const isoSeconds = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';
