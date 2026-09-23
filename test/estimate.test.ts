import { describe, expect, it } from 'vitest';
import { estimatePosition, indexAtEffort, nextEta, PACE_SLOWDOWN } from '../src/shared/estimate';
import { buildTrack, type RaceConfig, type RouteData } from '../src/shared/race';

// A flat 20 km route with a point every km and 500 m of climb in the second half.
const km = Array.from({ length: 21 }, (_, i) => i);
const route: RouteData = {
  coords: km.map(k => [k, 0]),
  ele: km.map(k => (k > 10 ? 1000 + (k - 10) * 50 : 1000)),
  km,
  gain: km.map(k => (k > 10 ? (k - 10) * 50 : 0)),
  cps: [
    { key: 'Start', label: 'Start', km: 0, i: 0, lon: 0, lat: 0, ele: 1000, gain: 0 },
    { key: 'CP1', label: 'CP1', km: 10, i: 10, lon: 10, lat: 0, ele: 1000, gain: 0 },
    { key: 'Finish', label: 'Finish', km: 20, i: 20, lon: 20, lat: 0, ele: 1500, gain: 500 },
  ],
  totalKm: 20,
  totalGain: 500,
};
const contest = { id: 1, name: '20K', start: '2026-01-01T06:00:00Z', track: { routeFile: 'r.json', checkpoints: [] } };
const race = { id: 't', name: 'Test', location: '', timezone: 'UTC', raceresult: { server: '', eventId: '', key: '', listName: '' }, contests: [contest] } as RaceConfig;
const track = buildTrack(race, contest, route);
const start = Date.parse(contest.start);

describe('effort-km', () => {
  it('adds 1 km per 100 m of climb', () => {
    expect(track.byKey.Finish!.effort).toBe(25);
    expect(indexAtEffort(track.effort, 12.5)).toBe(12);
  });
});

describe('nextEta', () => {
  it('projects the next checkpoint at the race-average effort pace, slowed down', () => {
    const eta = nextEta(track, 'CP1', 3600)!; // 10 effort-km in 1 h
    expect(eta.next.key).toBe('Finish');
    expect(eta.segSec).toBeCloseTo(15 * 360 * PACE_SLOWDOWN);
    expect(eta.etaMs).toBe(start + (3600 + eta.segSec) * 1000);
  });

  it('has no ETA after the finish or without a pace', () => {
    expect(nextEta(track, 'Finish', 9000)).toBeNull();
    expect(nextEta(track, 'Start', 0)).toBeNull();
  });
});

describe('estimatePosition', () => {
  it('moves a runner along the next segment as time passes', () => {
    const halfway = start + 3600_000 + nextEta(track, 'CP1', 3600)!.segSec * 500;
    const e = estimatePosition(track, 'CP1', 3600, false, halfway);
    expect(e.cp.key).toBe('CP1');
    expect(e.estimated).toBe(true);
    expect(e.i).toBeGreaterThan(10);
    expect(e.i).toBeLessThan(20);
    expect(e.overdue).toBe(false);
  });

  it('keeps finishers at the finish', () => {
    expect(estimatePosition(track, 'Finish', 9000, true, Date.now()).i).toBe(20);
  });
});
