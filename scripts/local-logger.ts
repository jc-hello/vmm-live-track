// Stopgap poller: appends every raw raceresult live list (all contests) to
// logs/contest_<id>.jsonl, e.g. while the Worker is not deployed yet.
// Replay the files into D1 later with `npm run backfill`.
//
//   npm run local-logger [-- --race vmm-2026 --every 30]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchJson, listUrl, runnerRows, type LiveListResponse } from '../src/shared/raceresult';
import { loadRaceFile, ROOT } from './lib';

const { values } = parseArgs({ options: { race: { type: 'string' }, every: { type: 'string', default: '30' } } });
const race = loadRaceFile(values.race);
const everyMs = Number(values.every) * 1000;
const dir = path.join(ROOT, 'logs');
fs.mkdirSync(dir, { recursive: true });
const headers = { 'user-agent': 'Mozilla/5.0', ...race.raceresult.headers };

for (;;) {
  const ts = new Date().toISOString().slice(0, 19) + '+00:00';
  for (const { id } of race.contests) {
    try {
      const j = await fetchJson<LiveListResponse>(listUrl(race.raceresult, id), { headers, signal: AbortSignal.timeout(20_000) });
      const line = JSON.stringify({ ts, contest: id, fields: j.DataFields ?? null, rows: runnerRows(j) });
      fs.appendFileSync(path.join(dir, `contest_${id}.jsonl`), line + '\n');
    } catch (e) {
      console.error(ts, id, 'ERR', (e as Error).message);
    }
  }
  console.log(ts, 'ok');
  await new Promise(r => setTimeout(r, everyMs));
}
