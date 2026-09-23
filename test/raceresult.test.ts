import { describe, expect, it } from 'vitest';
import { columnMap, parseDuration, parseRow, splitMaps } from '../src/shared/raceresult';

// Same shape as a raceresult LiveRank row (names are made up).
const row = (bib: string, last: string, total: string, extra: Partial<Record<number, string>> = {}) => {
  const r = [bib, '21473', '1st', '1st Male | M40 | Div. rank: 1', `${bib} - Jane Runner`, 'Trail Club', 'VNM', '[img:/graphics/flags/VN.svg]', last, 'Next: CPM2 Lap2', total, 'Diff / 1st: +1:11'];
  for (const [i, v] of Object.entries(extra)) r[+i] = v!;
  return r;
};

describe('parseDuration', () => {
  it('parses h:mm:ss, mm:ss and ss', () => {
    expect(parseDuration('01:39:48')).toBe(5988);
    expect(parseDuration('39:48')).toBe(2388);
    expect(parseDuration('48')).toBe(48);
    expect(parseDuration('x:1')).toBeNull();
  });
});

describe('splitMaps', () => {
  it('maps labels and names to split names per contest, with aliases', () => {
    const m = splitMaps({ splits: [{ Contest: 160, Name: 'CP_SAPA1', Label: 'CP Sapa Lap1' }] }, { 'Pre Finish': 'Finish' });
    expect(m[160]).toEqual({ 'Pre Finish': 'Finish', CP_SAPA1: 'CP_SAPA1', 'CP Sapa Lap1': 'CP_SAPA1' });
  });
});

describe('parseRow', () => {
  const labels = { 'CP Sapa Lap1': 'CP_SAPA1' };

  it('parses a runner who passed a checkpoint', () => {
    const o = parseRow(row('16293', 'Arrived at CP Sapa Lap1 at 09:39:48', 'Total time to CP Sapa Lap1: 01:39:48'), labels);
    expect(o).toMatchObject({
      bib: '16293',
      name: 'Jane Runner',
      rank: 1,
      gRank: 1,
      gender: 'Male',
      ageGroup: 'M40',
      aRank: 1,
      split: 'CP_SAPA1',
      splitLabel: 'CP Sapa Lap1',
      tod: '09:39:48',
      elapsed: 5988,
      finished: 0,
      gap: '+1:11',
      next: 'CPM2 Lap2',
    });
  });

  it('parses a finisher', () => {
    const o = parseRow(row('1', 'Time: 25:01:02', ''), labels);
    expect(o).toMatchObject({ split: 'Finish', finished: 1, elapsed: 90062 });
  });

  it('leaves split empty before the first checkpoint', () => {
    const o = parseRow(row('2', '', ''), labels);
    expect(o).toMatchObject({ split: null, elapsed: null, finished: 0 });
  });

  it('finds columns by DataFields expression when the layout changes', () => {
    const fields = ['[BIB]', '[ID]', 'OverallRankLive', 'GenderRankLive', 'DisplayName', 'NATION.ALPHA3', 'flag', '"Arrived at "', '"Next: "', '"Total time to "', 'Diff / 1st'];
    const r = ['7', '99', '3rd', '2nd Female', 'Ann Other', 'FRA', '', 'Arrived at CP Sapa Lap1 at 10:00:00', 'Next: X', 'Total time to CP Sapa Lap1: 02:00:00', 'Diff / 1st: +20:12', ''];
    const o = parseRow(r, labels, columnMap(fields));
    expect(o).toMatchObject({ bib: '7', rank: 3, name: 'Ann Other', club: '', nat: 'FRA', split: 'CP_SAPA1', elapsed: 7200, gap: '+20:12' });
  });
});
