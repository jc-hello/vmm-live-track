// Replays logs/contest_*.jsonl (from scripts/local-logger.ts) through the same diff logic
// as the logger Worker and writes backfill.sql. Load it with:
//
//   npm run backfill [-- --race vmm-2026]
//   npx wrangler d1 execute <database> --remote --file backfill.sql
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyEvents, diffEvents, eventStatements, snapshotStatement, type ContestState, type SqlDb } from '../src/shared/events';
import { columnMap, configUrl, fetchJson, labelMapFor, parseRow, splitMaps, type RawRow, type SplitConfigResponse } from '../src/shared/raceresult';
import { loadRaceFile, ROOT } from './lib';

const SNAPSHOT_EVERY_MS = 2 * 60_000;

const { values } = parseArgs({ options: { race: { type: 'string' }, out: { type: 'string', default: 'backfill.sql' } } });
const race = loadRaceFile(values.race);

interface Bound {
  sql: string;
  args: unknown[];
}
const sqlLiteral = (v: unknown) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const db: SqlDb<Bound> = { prepare: sql => ({ bind: (...args) => ({ sql, args }) }) };
const render = (st: Bound) => {
  let i = 0;
  return st.sql.replace(/\s+/g, ' ').replace(/\?/g, () => sqlLiteral(st.args[i++])) + ';';
};

const maps = splitMaps(await fetchJson<SplitConfigResponse>(configUrl(race.raceresult), { headers: race.raceresult.headers }), race.labelAliases);
const out: string[] = [];

for (const { id: c } of race.contests) {
  const file = path.join(ROOT, 'logs', `contest_${c}.jsonl`);
  if (!fs.existsSync(file)) continue;
  const state: ContestState = {};
  let lastSlot: number | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { ts, rows, fields } = JSON.parse(line) as { ts: string; rows: RawRow[]; fields?: string[] | null };
    const cols = columnMap(fields);
    const recs = rows.map(r => parseRow(r, labelMapFor(maps, c, race), cols));
    if (!recs.length && !Object.keys(state).length) continue;
    const t = ts.slice(0, 19) + 'Z';
    const ev = diffEvents(recs, state);
    for (const s of eventStatements(db, c, ev, t)) out.push(render(s));
    const slot = Math.floor(Date.parse(t) / SNAPSHOT_EVERY_MS);
    if (slot !== lastSlot) {
      out.push(render(snapshotStatement(db, t, c, recs)));
      lastSlot = slot;
    }
    applyEvents(state, ev);
  }
}
fs.writeFileSync(values.out!, out.join('\n') + '\n');
console.log(`${values.out}: ${out.length} statements`);
