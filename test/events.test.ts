import { describe, expect, it } from 'vitest';
import { applyEvents, diffEvents, eventStatements, type ContestState, type SqlDb } from '../src/shared/events';
import type { LiveRunner } from '../src/shared/raceresult';

const runner = (bib: string, split: string | null, elapsed: number | null, finished: 0 | 1 = 0): LiveRunner => ({
  bib, rrId: bib, name: `Runner ${bib}`, club: '', nat: 'VNM', rank: 1, rankText: '1st', gap: '', gRank: 1, genderText: '',
  gender: 'Male', ageGroup: null, aRank: null, split, splitLabel: split, tod: '10:00:00', elapsed, finished, next: '',
});

describe('diffEvents', () => {
  it('adds new runners and records their passing', () => {
    const ev = diffEvents([runner('1', 'CP1', 100)], {});
    expect(ev.added.map(o => o.bib)).toEqual(['1']);
    expect(ev.passed.map(o => o.bib)).toEqual(['1']);
  });

  it('records a new checkpoint as an update plus a passing', () => {
    const state: ContestState = { '1': { split: 'CP1', status: 'running', finished: 0, elapsed: 100 } };
    const ev = diffEvents([runner('1', 'CP2', 200)], state);
    expect(ev.updated.map(o => o.bib)).toEqual(['1']);
    expect(ev.passed.map(o => o.split)).toEqual(['CP2']);
    expect(ev.corrected).toEqual([]);
  });

  it('follows a re-timed checkpoint', () => {
    const state: ContestState = { '1': { split: 'CP1', status: 'running', finished: 0, elapsed: 100 } };
    const ev = diffEvents([runner('1', 'CP1', 120)], state);
    expect(ev.passed).toEqual([]);
    expect(ev.corrected.map(o => o.elapsed)).toEqual([120]);
  });

  it('marks runners missing from a full list, but not from a truncated one', () => {
    const state: ContestState = {};
    for (const b of ['1', '2', '3', '4']) state[b] = { split: 'CP1', status: 'running', finished: 0, elapsed: 100 };
    const full = [runner('1', 'CP1', 100), runner('2', 'CP1', 100), runner('3', 'CP1', 100)];
    expect(diffEvents(full, state).missing).toEqual(['4']);
    expect(diffEvents(full.slice(0, 1), state).missing).toEqual([]);
  });

  it('never marks finishers missing', () => {
    const state: ContestState = { '1': { split: 'Finish', status: 'running', finished: 1, elapsed: 900 } };
    expect(diffEvents([], state).missing).toEqual([]);
  });
});

describe('applyEvents + eventStatements', () => {
  it('advances state and emits one statement per change', () => {
    const state: ContestState = {};
    const db: SqlDb<{ sql: string; args: unknown[] }> = { prepare: sql => ({ bind: (...args) => ({ sql, args }) }) };
    const ev = diffEvents([runner('1', 'CP1', 100)], state);
    const stmts = eventStatements(db, 160, ev, '2026-09-18T02:00:00Z');
    expect(stmts.map(s => s.sql.split(' ')[0])).toEqual(['INSERT', 'INSERT']);
    applyEvents(state, ev);
    expect(state['1']).toEqual({ split: 'CP1', status: 'running', finished: 0, elapsed: 100 });
    expect(diffEvents([runner('1', 'CP1', 100)], state)).toMatchObject({ added: [], updated: [], passed: [], corrected: [], missing: [] });
  });
});
