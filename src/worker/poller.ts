// Durable Object that polls the raceresult live lists every 30 s and logs changes to D1.
// Everything the loop needs lives in memory; D1 is read once per cold start and after
// that only written. The API reads precomputed rows from `cache`.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { loadRace } from './race';
import { watch, alertsEnabled } from './alerts';
import { trackedContests } from '../shared/race';
import { configUrl, fetchJson, fetchLiveList, labelMapFor, splitMaps, type LiveRunner, type SplitConfigResponse, type SplitMaps } from '../shared/raceresult';
import { applyEvents, diffEvents, eventStatements, isoSeconds, snapshotStatement, type ContestState, type PollEvents } from '../shared/events';

const EVERY_MS = 30_000;
/** Offset inside each slot so polls land at :03 and :33. */
const SLOT_OFFSET_MS = 3_000;
const CONFIG_TTL = 10 * 60_000; // raceresult split config
const IDLE_RECHECK = 5 * 60_000; // contests that haven't started
const SNAPSHOT_EVERY = 2 * 60_000; // full ranking archive (write-only table)
const RANK_SAMPLE_EVERY = 10 * 60_000;

/** [bib, name, nat, club, gender, ageGroup, status, finished, lastSplit, lastElapsed] */
export type FieldRunner = [string, string, string, string, string | null, string | null, string, 0 | 1, string | null, number | null];
/** [bib, split, elapsed, tod, rankOverall, rankGender] */
export type FieldPassing = [string, string, number | null, string | null, number | null, number | null];

interface Field {
  runners: Map<string, FieldRunner>;
  passings: FieldPassing[];
  keys: Set<string>;
}
interface RankSeries {
  ts: string[];
  series: Map<string, (number | null)[]>;
}
interface ContestMemory {
  state: ContestState;
  field: Field | null;
  ranks: RankSeries | null;
  dirty?: boolean;
}
interface Memory {
  contests: Record<number, ContestMemory>;
}

export interface PollResult {
  /** Live list of the watched contest, or null when it could not be fetched. */
  recs: LiveRunner[] | null;
  ok: boolean;
  log: string;
}

const upsertCache = (db: D1Database, key: string, data: string, ts: string) =>
  db
    .prepare('INSERT INTO cache (key,updated,data) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET updated=excluded.updated, data=excluded.data')
    .bind(key, ts, data);

const fieldJson = (contest: number, f: Field, ts: string) =>
  JSON.stringify({ contest, updated: ts, runners: [...f.runners.values()], passings: f.passings });

function applyToField(f: Field, ev: PollEvents) {
  for (const o of ev.added) f.runners.set(o.bib, [o.bib, o.name, o.nat, o.club, o.gender, o.ageGroup, 'running', o.finished, o.split, o.elapsed]);
  for (const o of ev.updated) {
    const r = f.runners.get(o.bib);
    if (r) {
      r[6] = 'running';
      r[7] = o.finished;
      r[8] = o.split;
      r[9] = o.elapsed;
    }
  }
  for (const o of ev.passed) {
    const k = `${o.bib}|${o.split}`;
    if (!f.keys.has(k)) {
      f.keys.add(k);
      f.passings.push([o.bib, o.split!, o.elapsed, o.tod, o.rank, o.gRank]);
    }
  }
  for (const o of ev.corrected) {
    const p = f.passings.find(p => p[0] === o.bib && p[1] === o.split);
    if (p) {
      p[2] = o.elapsed;
      p[3] = o.tod;
    }
    const r = f.runners.get(o.bib);
    if (r) r[9] = o.elapsed;
  }
  for (const bib of ev.missing) {
    const r = f.runners.get(bib);
    if (r) r[6] = 'missing';
  }
}

// Rank series as "|bib:r1,r2,,r4|" so the API can cut one runner out with SQL substr().
const ranksText = (rk: RankSeries) => '|' + [...rk.series].map(([b, a]) => `${b}:${a.map(x => x ?? '').join(',')}`).join('|') + '|';

function parseRanks(ts: string[], text: string | undefined): RankSeries {
  const series = new Map<string, (number | null)[]>();
  for (const part of (text || '').split('|')) {
    if (!part) continue;
    const [b, v = ''] = part.split(':');
    series.set(b!, v.split(',').map(x => (x === '' ? null : +x)));
  }
  return { ts, series };
}

// Kept at module scope: survives the DO object being recycled between alarms as long
// as the isolate is reused, so raceresult isn't asked for these every poll.
const RR_CACHE: { cfg: SplitMaps | null; cfgAt: number; idleUntil: Record<number, number> } = { cfg: null, cfgAt: 0, idleUntil: {} };
interface Status {
  bootAt?: string;
  loads?: number;
  lastOk?: string;
  lastErr?: string;
  watchErr?: string;
  watch?: unknown;
}
const STATUS: Status = {}; // health fields for /logger/status (the clock isn't available at module init)

export class Poller extends DurableObject<Env> {
  private mem: Memory | null = null;
  private rebuild = false;
  private status = STATUS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    STATUS.bootAt ||= new Date().toISOString();
  }

  // A cold start costs one small query: the precomputed `cache` rows already hold every
  // runner's last split/status/elapsed. The tables are read only to rebuild (/logger/reload).
  private async load(contestIds: number[]): Promise<Memory> {
    if (this.mem) return this.mem;
    const db = this.env.DB;
    const { results } = await db.prepare('SELECT key, data FROM cache').all<{ key: string; data: string }>();
    const cached = Object.fromEntries(results.map(r => [r.key, r.data]));
    const mem: Memory = { contests: {} };
    this.status.loads = (this.status.loads || 0) + 1;
    for (const c of contestIds) {
      const C: ContestMemory = (mem.contests[c] = { state: {}, field: null, ranks: null });
      let fj: { runners: FieldRunner[]; passings: FieldPassing[] } | null =
        !this.rebuild && cached[`field:${c}`] ? JSON.parse(cached[`field:${c}`]!) : null;
      if (!fj && this.rebuild) {
        const [r, p] = await db.batch<Record<string, unknown>>([
          db.prepare('SELECT bib,name,nat,club,gender,age_group,status,finished,last_split,last_elapsed FROM runners WHERE contest=?').bind(c),
          db.prepare('SELECT bib,split,elapsed,tod,rank_overall,rank_gender FROM passings WHERE contest=? ORDER BY elapsed').bind(c),
        ]);
        if (r!.results.length)
          fj = {
            runners: r!.results.map(x => Object.values(x) as FieldRunner),
            passings: p!.results.map(x => Object.values(x) as FieldPassing),
          };
      }
      if (!fj) continue; // contest not started yet
      for (const x of fj.runners) C.state[x[0]] = { split: x[8], status: x[6] as 'running' | 'missing', finished: x[7], elapsed: x[9] };
      C.field = { runners: new Map(fj.runners.map(x => [x[0], x])), passings: fj.passings, keys: new Set(fj.passings.map(p => `${p[0]}|${p[1]}`)) };
      C.ranks = parseRanks(cached[`rankts:${c}`] ? JSON.parse(cached[`rankts:${c}`]!) : [], cached[`ranks:${c}`]);
      if (this.rebuild) C.dirty = true; // write the rebuilt field cache on the next poll
    }
    console.log('load', this.rebuild ? 'rebuild' : 'cache', results.length, 'rows');
    this.rebuild = false;
    return (this.mem = mem);
  }

  private async poll(now: number, watchContest: number | null): Promise<PollResult> {
    const race = await loadRace(this.env);
    const rr = race.raceresult;
    const init = { headers: rr.headers ?? {} };
    const contestIds = race.contests.map(c => c.id);
    const alwaysPoll = new Set(trackedContests(race).map(c => c.id));
    const mem = await this.load(contestIds);
    const db = this.env.DB;
    const ts = isoSeconds(now);
    if (!RR_CACHE.cfg || now - RR_CACHE.cfgAt > CONFIG_TTL) {
      RR_CACHE.cfg = splitMaps(await fetchJson<SplitConfigResponse>(configUrl(rr), init), race.labelAliases);
      RR_CACHE.cfgAt = now;
    }
    const cfg = RR_CACHE.cfg;
    // first poll of each fixed time slot, so a DO restart can't double-write
    const firstIn = (every: number) => Math.floor(now / every) !== Math.floor((now - EVERY_MS) / every);
    const snap = firstIn(SNAPSHOT_EVERY), sample = firstIn(RANK_SAMPLE_EVERY);
    const log: string[] = [];
    let watched: LiveRunner[] | null = null, watchedOk = false;
    for (const c of contestIds) {
      const C = mem.contests[c]!;
      if (!alwaysPoll.has(c) && now < (RR_CACHE.idleUntil[c] || 0)) continue;
      let recs: LiveRunner[];
      try {
        recs = await fetchLiveList(rr, c, labelMapFor(cfg, c, race), init);
      } catch (e) {
        // nothing was written, so memory is still in sync; retry untracked contests later
        log.push(`${c}:ERR ${(e as Error).message}`);
        if (!alwaysPoll.has(c)) RR_CACHE.idleUntil[c] = now + IDLE_RECHECK;
        continue;
      }
      try {
        if (c === watchContest) watched = recs;
        if (!recs.length && !Object.keys(C.state).length) {
          RR_CACHE.idleUntil[c] = now + IDLE_RECHECK; // not started
          continue;
        }
        C.field ||= { runners: new Map(), passings: [], keys: new Set() };
        C.ranks ||= { ts: [], series: new Map() };

        const ev = diffEvents(recs, C.state);
        const stmts = eventStatements(db, c, ev, ts);
        const changed = stmts.length > 0;
        if (snap) stmts.push(snapshotStatement(db, ts, c, recs));
        if (sample) {
          const i = C.ranks.ts.length;
          C.ranks.ts.push(ts);
          for (const o of recs) {
            const a = C.ranks.series.get(o.bib) || [];
            while (a.length < i) a.push(null);
            a[i] = o.rank;
            C.ranks.series.set(o.bib, a);
          }
        }
        // apply to memory first so the cache rows reflect this poll
        applyEvents(C.state, ev);
        applyToField(C.field, ev);
        if (changed || C.dirty) stmts.push(upsertCache(db, `field:${c}`, fieldJson(c, C.field, ts), ts));
        C.dirty = false;
        if (sample) stmts.push(upsertCache(db, `ranks:${c}`, ranksText(C.ranks), ts), upsertCache(db, `rankts:${c}`, JSON.stringify(C.ranks.ts), ts));
        if (stmts.length) await db.batch(stmts); // D1 rejects an empty batch
        if (c === watchContest) watchedOk = recs.length > 0; // healthy = fetched AND stored
        log.push(`${c}:${recs.length}/${stmts.length}`);
      } catch (e) {
        log.push(`${c}:DB ERR ${(e as Error).message}`);
        this.mem = null; // a write failed: resync from D1 next time rather than trust memory
        break;
      }
    }
    console.log(ts, log.join(' '), `rr:${1 + log.length}${RR_CACHE.cfgAt === now ? '+cfg' : ''}`);
    return { recs: watched, ok: watchedOk, log: log.join(' ') };
  }

  override async alarm() {
    const now = Date.now();
    // reschedule first so a failed poll can't stop the loop; align to fixed slots so they never drift
    await this.ctx.storage.setAlarm((Math.floor(now / EVERY_MS) + 1) * EVERY_MS + SLOT_OFFSET_MS);
    let watchContest: number | null = null;
    let res: PollResult = { recs: null, ok: false, log: '' };
    try {
      const race = await loadRace(this.env);
      watchContest = +(this.env.WATCH_CONTEST || trackedContests(race)[0]?.id || race.contests[0]!.id);
      res = await this.poll(now, watchContest);
    } catch (e) {
      res.log = (e as Error).message;
      this.mem = null;
    }
    if (res.ok) this.status.lastOk = new Date(now).toISOString();
    else this.status.lastErr = `${new Date(now).toISOString()} ${res.log}`;
    if (alertsEnabled(this.env) && watchContest != null) {
      try {
        this.status.watch = await watch(this.env, this.ctx.storage, watchContest, res.recs, res.ok, this.status.lastErr);
      } catch (e) {
        this.status.watchErr = `${new Date(now).toISOString()} ${(e as Error).message}`;
      }
    }
  }

  override async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    if (path === '/start' && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
    if (path === '/stop') await this.ctx.storage.deleteAlarm();
    if (path === '/reload') {
      this.mem = null; // rebuild memory + field cache from the tables
      this.rebuild = true;
    }
    const alarm = await this.ctx.storage.getAlarm();
    const { lastOk, lastErr, watchErr, bootAt, loads, watch } = this.status;
    return Response.json({
      running: !!alarm,
      nextAlarm: alarm && new Date(alarm).toISOString(),
      lastOk,
      lastErr,
      bootAt,
      loads,
      alerts: alertsEnabled(this.env) ? { bibs: this.env.WATCH_BIBS, state: watch ?? (await this.ctx.storage.get('watch')), watchErr } : 'disabled',
    });
  }
}
