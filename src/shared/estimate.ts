// Position and ETA estimates from a runner's own effort-km pace.
// The map page, the analytics page and the email alerts all use this one rule.
import type { Checkpoint, Track } from './race';

/** Runners slow down; project the race-average pace this much slower. */
export const PACE_SLOWDOWN = 1.04;
/** Pace before the first checkpoint gives us data, seconds per effort-km. */
export const DEFAULT_PACE_S = 540;
/** Never draw an estimated position past this share of the next segment. */
const MAX_SEGMENT_FRACTION = 0.97;

export interface NextEta {
  cp: Checkpoint;
  next: Checkpoint;
  /** Expected time for the segment, seconds. */
  segSec: number;
  etaMs: number;
}

/** Seconds per effort-km so far, slowed down by PACE_SLOWDOWN. */
export function racePace(elapsed: number | null, effortAtCp: number): number | null {
  return elapsed && effortAtCp > 0.5 ? (elapsed / effortAtCp) * PACE_SLOWDOWN : null;
}

export function nextEta(track: Track, split: string | null, elapsed: number | null, fallbackPace = false): NextEta | null {
  const cp = track.byKey[split ?? 'Start'] ?? track.cps[0]!;
  const next = track.cps[track.cps.indexOf(cp) + 1];
  if (!next) return null;
  const pace = racePace(elapsed, cp.effort) ?? (fallbackPace ? DEFAULT_PACE_S : null);
  if (pace == null) return null;
  const segSec = (next.effort - cp.effort) * pace;
  return { cp, next, segSec, etaMs: track.startMs + ((elapsed ?? 0) + segSec) * 1000 };
}

/** Binary search: first route index at or beyond an effort-km value. */
export function indexAtEffort(effort: number[], e: number) {
  let lo = 0, hi = effort.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (effort[m]! < e) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export interface PositionEstimate {
  /** Last confirmed checkpoint. */
  cp: Checkpoint;
  nextCp: Checkpoint | null;
  /** Estimated route index. */
  i: number;
  /** True when the position is interpolated past the last checkpoint. */
  estimated: boolean;
  etaMs: number | null;
  overdue: boolean;
}

/** Where a runner probably is now, interpolated along the route at their own pace. */
export function estimatePosition(track: Track, split: string | null, elapsed: number | null, finished: boolean, nowMs: number): PositionEstimate {
  const cp = track.byKey[split ?? 'Start'] ?? track.cps[0]!;
  const res: PositionEstimate = { cp, nextCp: null, i: cp.i, estimated: false, etaMs: null, overdue: false };
  if (finished) return res;
  const eta = nextEta(track, split, elapsed, true);
  if (!eta) return res;
  const arrivedMs = track.startMs + (elapsed ?? 0) * 1000;
  const frac = Math.min(MAX_SEGMENT_FRACTION, Math.max(0, (nowMs - arrivedMs) / 1000 / eta.segSec));
  res.nextCp = eta.next;
  res.etaMs = eta.etaMs;
  res.i = indexAtEffort(track.effort, cp.effort + frac * (eta.next.effort - cp.effort));
  res.estimated = frac > 0;
  res.overdue = nowMs > eta.etaMs;
  return res;
}
