// Read-only API over the D1 race log. Every endpoint reads precomputed rows from
// `cache` (kept current by the logger), so a request costs a single D1 row read.
import type { Env } from './env';
import { loadRace } from './race';
import { trackedContests } from '../shared/race';

const json = (body: unknown, maxAge = 30, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '');
  const race = await loadRace(env);
  const contest = +(url.searchParams.get('contest') || trackedContests(race)[0]?.id || race.contests[0]!.id);
  const bib = url.searchParams.get('bib');

  if (route === 'field') {
    const row = await env.DB.prepare('SELECT data FROM cache WHERE key=?').bind(`field:${contest}`).first<{ data: string }>();
    return row ? json(row.data) : json({ contest, runners: [], passings: [] });
  }

  if (route === 'ranklog' && bib && /^\w+$/.test(bib)) {
    // cut "|bib:r1,r2,...|" out of the series text inside SQLite
    const tag = `|${bib}:`;
    const row = await env.DB.prepare(
      `SELECT (SELECT data FROM cache WHERE key=?2) AS ts,
              substr(r.data, instr(r.data, ?1) + length(?1),
                     instr(substr(r.data, instr(r.data, ?1) + length(?1)), '|') - 1) AS series,
              instr(r.data, ?1) AS found
       FROM cache r WHERE r.key=?3`,
    )
      .bind(tag, `rankts:${contest}`, `ranks:${contest}`)
      .first<{ ts: string | null; series: string | null; found: number }>();
    const ts: string[] = row?.ts ? JSON.parse(row.ts) : [];
    const vals = row?.found && row.series != null ? row.series.split(',') : [];
    const points = vals.map((v, i) => [ts[i], v === '' ? null : +v] as const).filter(p => p[1] != null && p[0]);
    return json({ bib, points }, 120);
  }

  if (route === 'health') {
    const { results } = await env.DB.prepare('SELECT key, updated, length(data) AS bytes FROM cache').all();
    return json(results, 10);
  }
  return json({ error: 'not found' }, 0, 404);
}
