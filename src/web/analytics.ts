// Analytics page: pacing, fatigue and rank analysis for one runner against the field.
import Chart, { type ChartConfiguration } from 'chart.js/auto';
import './analytics.css';
import { $, fetchLive, loadLabelMap, loadRaceContext, pageLink, params, setUrlParams, type RaceContext } from './common';
import { racePace } from '../shared/estimate';
import { escapeHtml as esc, hm, hms, mmss, shortName } from '../shared/format';
import type { Checkpoint } from '../shared/race';
import { fetchJson } from '../shared/raceresult';

const REFRESH_MS = 60_000;
const RANK_SAMPLE_MS = 10 * 60_000; // the server samples live ranks this often
/** A field median only means something once this share of the field has been through. */
const MIN_FIELD_SHARE = 0.3;
const MIN_FIELD = 10;
const HIST_BIN_S = 600;
const C = { runner: '#d95926', compare: '#3987e5', median: '#8c9a93', band: 'rgba(140,154,147,.16)', grid: '#1f2825', text: '#8c9a93', faint: '#5d6b65', bar: '#3a4641' };

interface Runner {
  bib: string;
  name: string;
  nat: string;
  club: string;
  gender?: string | null;
  ageGroup?: string | null;
  status: string;
  finished?: 0 | 1;
}
interface Live {
  bib: string;
  rank: number | null;
  rankText: string;
  gender: string | null;
  name: string;
  club: string;
  nat: string;
  gap: string;
  next: string;
}
interface FieldResponse {
  runners: [string, string, string, string, string | null, string | null, string, 0 | 1, string | null, number | null][];
  passings: [string, string, number | null][];
}
interface Segment {
  from: string;
  to: string;
  km: number;
  eff: number;
}
interface SegmentRow extends Segment {
  i: number;
  t: number | null;
  tc: number | null;
  med: number | null;
  n: number;
  pct: number | null;
  pace: number | null;
  paceC: number | null;
  paceMed: number | null;
}
type Point = { x: string; y: number };

let ctx: RaceContext;
let CPS: Checkpoint[] = [];
let labelMap: Record<string, string> | null = null;
let bib = params.get('bib') ?? '';
let cmpBib = params.get('vs') || 'leader';
let runners: Record<string, Runner> = {};
/** bib -> split -> race time (s) */
let T: Record<string, Record<string, number>> = {};
let live: Record<string, Live> = {};
let liveOrder: string[] = [];
let rankLog: { points: [string, number][] } | null = null;
let rankLogAt = 0;
const charts: Record<string, Chart> = {};

Chart.defaults.color = C.text;
Chart.defaults.font.family = "'Be Vietnam Pro', system-ui, sans-serif";
Chart.defaults.font.size = 11.5;
Chart.defaults.borderColor = C.grid;
Chart.defaults.plugins.legend.display = false;
Object.assign(Chart.defaults.plugins.tooltip, {
  backgroundColor: '#0b0f0e',
  borderColor: '#2c3833',
  borderWidth: 1,
  padding: 10,
  titleColor: '#eef3ef',
  bodyColor: '#cfd8d3',
  boxPadding: 4,
});

const quant = (arr: number[], q: number) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * q, lo = Math.floor(i);
  return a[lo]! + (a[Math.min(lo + 1, a.length - 1)]! - a[lo]!) * (i - lo);
};
const SHORT = (k: string) => ctx.track.byKey[k]?.short ?? k;
const effort = (k: string) => ctx.track.byKey[k]?.effort ?? 0;
const at = (b: string, k: string) => T[b]?.[k];

// ---------- data ----------
async function loadAll() {
  labelMap ??= await loadLabelMap(ctx).catch(() => null);
  runners = {};
  T = {};
  try {
    const f = await fetchJson<FieldResponse>(`api/field?contest=${ctx.contest.id}`);
    for (const [b, name, nat, club, gender, ageGroup, status, finished] of f.runners) runners[b] = { bib: b, name, nat, club, gender, ageGroup, status, finished };
    for (const [b, split, el] of f.passings) if (el != null) (T[b] ||= {})[split] = el;
  } catch (e) {
    console.warn('api/field', e);
  }
  try {
    live = {};
    liveOrder = [];
    for (const o of await fetchLive(ctx, labelMap ?? {})) {
      live[o.bib] = { bib: o.bib, rank: o.rank, rankText: o.rankText, gender: o.genderText, name: o.name, club: o.club, nat: o.nat, gap: o.gap, next: o.next };
      liveOrder.push(o.bib);
      runners[o.bib] ??= { bib: o.bib, name: o.name, nat: o.nat, club: o.club, status: 'running' };
      if (o.split && o.elapsed != null) (T[o.bib] ||= {})[o.split] ??= o.elapsed; // merge the freshest passing
    }
  } catch (e) {
    console.warn('live', e);
  }
  for (const b in T) T[b]!.Start = 0;
  $('liveTxt').textContent = 'Live · ' + ctx.clock.time(Date.now());
}

async function loadRankLog() {
  try {
    rankLog = await fetchJson(`api/ranklog?contest=${ctx.contest.id}&bib=${encodeURIComponent(bib)}`);
  } catch {
    rankLog = null;
  }
}

// ---------- analytics ----------
const segs = (): Segment[] => CPS.slice(1).map((c, i) => ({ from: CPS[i]!.key, to: c.key, km: c.km - CPS[i]!.km, eff: c.effort - CPS[i]!.effort }));
const segTime = (b: string, s: Segment) => {
  const a = at(b, s.from), z = at(b, s.to);
  return a != null && z != null ? z - a : null;
};
const fieldSeg = (s: Segment) => Object.keys(T).map(b => segTime(b, s)).filter((x): x is number => x != null && x > 0);
const fieldSize = () => Math.max(Object.keys(live).length, Object.values(runners).filter(r => r.status === 'running' || r.finished).length, 1);
const enough = (n: number) => n >= Math.max(MIN_FIELD, MIN_FIELD_SHARE * fieldSize());
const fieldAt = (k: string) => Object.keys(T).map(b => T[b]![k]).filter((x): x is number => x != null);
const leaderBib = () => liveOrder[0] || Object.keys(T)[0] || '';
const resolveCmp = () => (cmpBib === 'leader' ? leaderBib() : cmpBib);
function lastCp(b: string) {
  let last: Checkpoint | null = null;
  for (const c of CPS) if (at(b, c.key) != null) last = c;
  return last;
}

function stats() {
  const cmp = resolveCmp();
  const rows: SegmentRow[] = segs().map((s, i) => {
    const all = fieldSeg(s);
    const t = segTime(bib, s), tc = segTime(cmp, s);
    const med = enough(all.length) ? quant(all, 0.5) : null;
    const pct = t != null && all.length > 1 ? Math.round((all.filter(x => x > t).length / (all.length - 1)) * 100) : null;
    return {
      ...s,
      i,
      t,
      tc,
      med,
      n: all.length,
      pct,
      pace: t != null ? t / 60 / s.eff : null,
      paceC: tc != null ? tc / 60 / s.eff : null,
      paceMed: med != null ? med / 60 / s.eff : null,
    };
  });
  return { rows, cmp };
}

// ---------- rendering ----------
function mk(id: string, cfg: ChartConfiguration) {
  charts[id]?.destroy();
  const cv = $<HTMLCanvasElement>(id);
  cv.parentElement!.querySelector('.empty')?.remove();
  charts[id] = new Chart(cv, cfg);
}
function empty(id: string, msg: string) {
  charts[id]?.destroy();
  delete charts[id];
  const wrap = $(id).parentElement!;
  if (!wrap.querySelector('.empty')) wrap.insertAdjacentHTML('beforeend', `<div class="empty">${esc(msg)}</div>`);
}
function legend(id: string, items: [label: string, color: string, kind?: string][]) {
  $(id).innerHTML = items.map(([label, color, kind]) => `<span><i class="${kind || ''}" style="background:${color}"></i>${esc(label)}</span>`).join('');
}
const nm = (b: string) => (runners[b] || live[b])?.name || b;
const short = (b: string) => shortName(nm(b));

function render() {
  const { rows, cmp } = stats();
  const me = live[bib], info = runners[bib];
  const myName = short(bib), cmpName = cmp === leaderBib() ? `Leader · ${short(cmp)}` : short(cmp);
  const { dayTime } = ctx.clock;

  // header
  const club = info?.club || me?.club;
  $('name').textContent = nm(bib);
  $('sub').textContent = `Bib ${bib} · ${info?.nat || me?.nat || ''}${club ? ' · ' + club : ''}${me?.gender ? ' · ' + me.gender : ''}`;
  $<HTMLAnchorElement>('tabMap').href = pageLink('./', ctx.contest.id, bib);

  // tiles
  const lc = lastCp(bib);
  const done = rows.filter(r => r.t != null);
  const missing = info?.status === 'missing';
  $('tRank').textContent = me ? me.rankText : missing ? 'DNF?' : '–';
  $('tRankSub').textContent = me ? `${me.gap} behind leader` : missing ? 'no longer on the live list' : '';
  $('tCp').textContent = lc ? SHORT(lc.key) : '–';
  $('tCpSub').textContent = lc ? `${CPS.indexOf(lc)}/${CPS.length - 1} CPs · km ${lc.km} · ${hms(at(bib, lc.key))}` : '';
  const lastSeg = done[done.length - 1];
  if (lastSeg?.med && lastSeg.t != null) {
    const d = (lastSeg.t / lastSeg.med - 1) * 100;
    $('tSeg').innerHTML = `<span class="${d <= 0 ? 'good' : 'bad'}">${d > 0 ? '+' : ''}${d.toFixed(0)}%</span>`;
    $('tSegSub').textContent = `${SHORT(lastSeg.from)}→${SHORT(lastSeg.to)} · ${hm(lastSeg.t)} (median ${hm(lastSeg.med)})`;
  } else {
    $('tSeg').textContent = '–';
    $('tSegSub').textContent = 'needs at least 1 complete segment';
  }
  const fat = fatigue(rows);
  if (fat.me.length > 1) {
    const v = fat.me[fat.me.length - 1]!.y, f = fat.med[fat.med.length - 1]?.y;
    $('tFat').innerHTML = `<span class="${f && v > f * 1.05 ? 'bad' : v < (f || v) * 0.97 ? 'good' : ''}">${v.toFixed(0)}</span>`;
    $('tFatSub').textContent = f ? `field median ${f.toFixed(0)} · 100 = first segment` : '100 = first segment';
  } else {
    $('tFat').textContent = '–';
    $('tFatSub').textContent = 'needs ≥ 2 segments';
  }
  const proj = projectFinish(rows, lc);
  if (proj) {
    $('tEta').textContent = hm(proj.mid);
    $('tEtaSub').textContent = `${hm(proj.lo)} – ${hm(proj.hi)} · ~${dayTime(ctx.track.startMs + proj.mid * 1000)}`;
  } else {
    $('tEta').textContent = '–';
    $('tEtaSub').textContent = 'needs more splits';
  }

  insights(rows, proj, lc);
  drawRace(cmp, myName, cmpName);
  drawGap();
  drawRank(cmp, myName, cmpName);
  drawSeg(rows, myName, cmpName);
  drawFat(fat, myName);
  drawLaps(cmp, myName, cmpName);
  drawPct(rows);
  drawLive();
  drawHist(lc);
  drawTable(rows);
}

function fatigue(rows: SegmentRow[]) {
  // index = segment effort pace / first available segment effort pace × 100
  const me: Point[] = [], med: Point[] = [];
  const base = rows.find(r => r.pace != null), baseM = rows.find(r => r.paceMed != null);
  for (const r of rows) {
    if (r.pace != null && base) me.push({ x: SHORT(r.to), y: (r.pace / base.pace!) * 100 });
    if (r.paceMed != null && baseM && r.pace != null) med.push({ x: SHORT(r.to), y: (r.paceMed / baseM.paceMed!) * 100 });
  }
  return { me, med };
}

function projectFinish(rows: SegmentRow[], lc: Checkpoint | null) {
  if (!lc) return null;
  const t0 = at(bib, lc.key)!;
  if (lc.key === 'Finish') return { mid: t0, lo: t0, hi: t0 };
  const done = rows.filter(r => r.pace != null);
  if (!done.length) return null;
  // recent effort pace (last 3 segments, weighted to the latest), then slow it for the remaining distance
  const rec = done.slice(-3), w = rec.map((_, i) => i + 1);
  const pace = rec.reduce((a, r, i) => a + r.pace! * w[i]!, 0) / w.reduce((a, b) => a + b, 0); // min / effort-km
  const rem = (effort('Finish') - lc.effort) * pace * 60;
  return { mid: t0 + rem * 1.12, lo: t0 + rem, hi: t0 + rem * 1.3 };
}

function insights(rows: SegmentRow[], proj: ReturnType<typeof projectFinish>, lc: Checkpoint | null) {
  const out: string[] = [];
  const done = rows.filter(r => r.t != null);
  const laps = ctx.contest.track.laps;
  const l = lapTimes(bib).filter((x): x is number => x != null);
  if (laps && l.length >= 2) {
    const d = (l[l.length - 1]! / l[0]! - 1) * 100;
    const mm = lapMedians().filter((x): x is number => x != null);
    const dm = mm.length >= l.length ? (mm[l.length - 1]! / mm[0]! - 1) * 100 : null;
    const verdict = dm == null ? '.' : d > dm + 5 ? '. Fading faster than the field.' : d < dm - 5 ? '. Holding up better than the field.' : '. Fading about as much as the field.';
    out.push(
      `${esc(laps.name)}: lap ${l.length} was <b>${Math.abs(d).toFixed(0)}%</b> ${d >= 0 ? 'slower' : 'faster'} than lap 1${dm != null ? ` (field median: ${dm >= 0 ? '+' : ''}${dm.toFixed(0)}%)` : ''}${verdict}`,
    );
  }
  const ranked = done.filter(r => r.pct != null);
  if (ranked.length) {
    const best = [...ranked].sort((a, b) => b.pct! - a.pct!)[0]!;
    const worst = [...ranked].sort((a, b) => a.pct! - b.pct!)[0]!;
    if (best !== worst)
      out.push(
        `Strongest segment: <b>${esc(SHORT(best.from))}→${esc(SHORT(best.to))}</b> (faster than ${best.pct}% of the field). Weakest: <b>${esc(SHORT(worst.from))}→${esc(SHORT(worst.to))}</b> (${worst.pct}%).`,
      );
    else out.push(`${esc(SHORT(best.from))}→${esc(SHORT(best.to))}: faster than <b>${best.pct}%</b> of runners on the same segment.`);
  }
  const ranks = CPS.map(c => rankAt(bib, c.key)).filter((x): x is number => x != null);
  if (ranks.length >= 2) {
    const d = ranks[0]! - ranks[ranks.length - 1]!;
    out.push(`Rank ${ranks[0]} (first checkpoint with data) → ${ranks[ranks.length - 1]}: <b class="${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : ''}${d} places</b>.`);
  }
  if (lc && lc.key !== 'Finish') {
    const nextCp = CPS[CPS.indexOf(lc) + 1];
    const t0 = at(bib, lc.key)!;
    // same rule as the map page and the alerts: race-average effort pace, slightly slowed
    const pace = racePace(t0, lc.effort);
    if (pace && nextCp) {
      const eta = t0 + (nextCp.effort - lc.effort) * pace;
      const now = (Date.now() - ctx.track.startMs) / 1000;
      out.push(
        `Expected at ${esc(SHORT(nextCp.key))} (km ${nextCp.km}) around <b>${ctx.clock.dayTime(ctx.track.startMs + eta * 1000)}</b>${
          now > eta + 1800 ? ' — <span class="warn">more than 30 minutes late at the current pace; possibly a long stop or in difficulty.</span>' : ''
        }`,
      );
    }
    if (live[bib]?.next && !nextCp) out.push(`Next checkpoint: ${esc(live[bib]!.next)}`);
  }
  if (proj) out.push(`Keeping the recent pace and slowing as usual in an ultra, the projected finish is <b>${hm(proj.mid)}</b> (range ${hm(proj.lo)}–${hm(proj.hi)}).`);
  if (!out.length) out.push('Not enough data yet: the runner needs to pass at least 2 checkpoints. This page refreshes every minute.');
  $('insights').innerHTML = out.map(x => `<li>${x}</li>`).join('');
}

function rankAt(b: string, k: string) {
  const t = at(b, k);
  if (t == null || k === 'Start') return null;
  return 1 + fieldAt(k).filter(x => x < t).length;
}
function lapTimes(b: string) {
  const keys = ctx.contest.track.laps?.checkpoints ?? [];
  return keys.slice(1).map((k, i) => {
    const a = at(b, keys[i]!), z = at(b, k);
    return a != null && z != null ? z - a : null;
  });
}
function lapMedians() {
  const bibs = Object.keys(T);
  const n = Math.max(0, (ctx.contest.track.laps?.checkpoints.length ?? 0) - 1);
  return Array.from({ length: n }, (_, i) => {
    const v = bibs.map(b => lapTimes(b)[i]).filter((x): x is number => !!x);
    return enough(v.length) ? quant(v, 0.5) : null;
  });
}

// Loosely typed on purpose: Chart.js option types are per chart type and deeply nested.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseOpts = (yTitle: string, extra: Record<string, any> = {}): any => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  interaction: { mode: 'index', intersect: false },
  scales: { x: { grid: { display: false } }, y: { title: { display: !!yTitle, text: yTitle }, grid: { color: C.grid } } },
  ...extra,
});

function drawRace(cmp: string, myName: string, cmpName: string) {
  const keys = CPS.filter(c => fieldAt(c.key).length > 0 || c.key === 'Start');
  if (keys.length < 2) return empty('cRace', 'Not enough checkpoints with data yet');
  const pt = (b: string, c: Checkpoint) => (at(b, c.key) != null ? { x: c.km, y: at(b, c.key)! / 3600 } : null);
  const band = (q: number) =>
    keys.filter(c => c.key === 'Start' || enough(fieldAt(c.key).length)).map(c => ({ x: c.km, y: c.key === 'Start' ? 0 : quant(fieldAt(c.key), q)! / 3600 }));
  legend('lgRace', [[myName, C.runner], [cmpName, C.compare], ['Median', C.median, 'dash'], ['Middle 50%', 'rgba(140,154,147,.35)', 'box']]);
  mk('cRace', {
    type: 'line',
    data: {
      datasets: [
        { label: '25%', data: band(0.25), borderWidth: 0, pointRadius: 0, fill: false },
        { label: '75%', data: band(0.75), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: C.band },
        { label: 'Median', data: band(0.5), borderColor: C.median, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0 },
        { label: cmpName, data: keys.map(c => pt(cmp, c)).filter(p => p != null), borderColor: C.compare, backgroundColor: C.compare, borderWidth: 2, pointRadius: 3 },
        { label: myName, data: keys.map(c => pt(bib, c)).filter(p => p != null), borderColor: C.runner, backgroundColor: C.runner, borderWidth: 2.5, pointRadius: 4 },
      ],
    },
    options: baseOpts('hours', {
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: ctx.track.route.totalKm, title: { display: true, text: 'km' }, grid: { display: false } },
        y: { min: 0, title: { display: true, text: 'hours' }, grid: { color: C.grid } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (it: { parsed: { x: number } }[]) => {
              const x = it[0]!.parsed.x;
              const c = CPS.find(c => Math.abs(c.km - x) < 0.01);
              return c ? `${c.label} · km ${c.km}` : `km ${x}`;
            },
            label: (it: { dataset: { label: string }; parsed: { y: number } }) => `${it.dataset.label}: ${hms(it.parsed.y * 3600)}`,
          },
        },
      },
    }),
  });
}

function drawGap() {
  const pts = CPS.slice(1)
    .filter(c => at(bib, c.key) != null && enough(fieldAt(c.key).length))
    .map(c => ({ c, d: (at(bib, c.key)! - quant(fieldAt(c.key), 0.5)!) / 60 }));
  if (!pts.length) return empty('cGap', 'No checkpoint with data yet');
  mk('cGap', {
    type: 'bar',
    data: { labels: pts.map(p => SHORT(p.c.key)), datasets: [{ label: 'vs median', data: pts.map(p => p.d), backgroundColor: C.runner, borderRadius: 4, maxBarThickness: 36 }] },
    options: baseOpts('minutes', {
      plugins: { tooltip: { callbacks: { label: (it: { parsed: { y: number } }) => `${Math.abs(it.parsed.y).toFixed(0)} min ${it.parsed.y > 0 ? 'slower' : 'faster'} than the median` } } },
    }),
  });
}

function drawRank(cmp: string, myName: string, cmpName: string) {
  const keys = CPS.slice(1).filter(c => fieldAt(c.key).length);
  if (!keys.length || !keys.some(c => rankAt(bib, c.key))) return empty('cRank', 'No checkpoint with data yet');
  legend('lgRank', [[myName, C.runner], [cmpName, C.compare]]);
  mk('cRank', {
    type: 'line',
    data: {
      labels: keys.map(c => SHORT(c.key)),
      datasets: [
        { label: cmpName, data: keys.map(c => rankAt(cmp, c.key)), borderColor: C.compare, backgroundColor: C.compare, borderWidth: 2, pointRadius: 3, spanGaps: true },
        { label: myName, data: keys.map(c => rankAt(bib, c.key)), borderColor: C.runner, backgroundColor: C.runner, borderWidth: 2.5, pointRadius: 4, spanGaps: true },
      ],
    },
    options: baseOpts('rank', { scales: { x: { grid: { display: false } }, y: { reverse: true, min: 1, title: { display: true, text: 'rank' }, grid: { color: C.grid } } } }),
  });
}

function drawSeg(rows: SegmentRow[], myName: string, cmpName: string) {
  const r = rows.filter(x => x.n > 0);
  if (!r.length) return empty('cSeg', 'No complete segment yet (needs 2 consecutive checkpoints)');
  legend('lgSeg', [[myName, C.runner, 'box'], [cmpName, C.compare, 'box'], ['Field median', C.median, 'box']]);
  const tip = {
    callbacks: {
      label: (it: { dataset: { label: string }; parsed: { y: number } }) => `${it.dataset.label}: ${mmss(it.parsed.y)} /effort-km`,
      afterBody: (it: { dataIndex: number }[]) => {
        const x = r[it[0]!.dataIndex]!;
        return `Segment ${x.km.toFixed(1)} km · +${Math.round((x.eff - x.km) * (ctx.race.climbMetersPerKm ?? 100))} m climb · ${x.n} runners`;
      },
    },
  };
  const bar = { borderRadius: 4, maxBarThickness: 22 };
  mk('cSeg', {
    type: 'bar',
    data: {
      labels: r.map(x => `${SHORT(x.from)}→${SHORT(x.to)}`),
      datasets: [
        { label: myName, data: r.map(x => x.pace), backgroundColor: C.runner, ...bar },
        { label: cmpName, data: r.map(x => x.paceC), backgroundColor: C.compare, ...bar },
        { label: 'Median', data: r.map(x => x.paceMed), backgroundColor: C.median, ...bar },
      ],
    },
    options: baseOpts('min / effort-km', { datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } }, plugins: { tooltip: tip } }),
  });
}

function drawFat(fat: ReturnType<typeof fatigue>, myName: string) {
  if (fat.me.length < 2) return empty('cFat', 'Needs at least 2 complete segments');
  legend('lgFat', [[myName, C.runner], ['Field median', C.median, 'dash']]);
  mk('cFat', {
    type: 'line',
    data: {
      labels: fat.me.map(p => p.x),
      datasets: [
        { label: 'Median', data: fat.med.map(p => p.y), borderColor: C.median, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 2 },
        { label: myName, data: fat.me.map(p => p.y), borderColor: C.runner, backgroundColor: C.runner, borderWidth: 2.5, pointRadius: 4 },
      ],
    },
    options: baseOpts('index (100 = first segment)', {
      plugins: { tooltip: { callbacks: { label: (it: { dataset: { label: string }; parsed: { y: number } }) => `${it.dataset.label}: ${it.parsed.y.toFixed(0)}` } } },
    }),
  });
}

function drawLaps(cmp: string, myName: string, cmpName: string) {
  const laps = ctx.contest.track.laps;
  $('lapCard').hidden = !laps;
  if (!laps) return;
  $('lapTitle').textContent = laps.name;
  if (laps.description) $('lapDesc').textContent = laps.description;
  const me = lapTimes(bib), c = lapTimes(cmp), m = lapMedians();
  if (!me.some(Boolean) && !m.some(Boolean)) return empty('cLap', 'No lap completed yet');
  legend('lgLap', [[myName, C.runner, 'box'], [cmpName, C.compare, 'box'], ['Field median', C.median, 'box']]);
  const h = (a: (number | null)[]) => a.map(x => (x ? x / 3600 : null));
  const bar = { borderRadius: 4, maxBarThickness: 26 };
  mk('cLap', {
    type: 'bar',
    data: {
      labels: m.map((_, i) => `Lap ${i + 1}`),
      datasets: [
        { label: myName, data: h(me), backgroundColor: C.runner, ...bar },
        { label: cmpName, data: h(c), backgroundColor: C.compare, ...bar },
        { label: 'Median', data: h(m), backgroundColor: C.median, ...bar },
      ],
    },
    options: baseOpts('hours', { plugins: { tooltip: { callbacks: { label: (it: { dataset: { label: string }; parsed: { y: number } }) => `${it.dataset.label}: ${hms(it.parsed.y * 3600)}` } } } }),
  });
}

function drawPct(rows: SegmentRow[]) {
  const r = rows.filter(x => x.pct != null);
  if (!r.length) return empty('cPct', 'No complete segment yet');
  mk('cPct', {
    type: 'bar',
    data: {
      labels: r.map(x => `${SHORT(x.from)}→${SHORT(x.to)}`),
      datasets: [{ label: 'Percentile', data: r.map(x => x.pct), backgroundColor: r.map(x => (x.pct! >= 50 ? C.compare : C.faint)), borderRadius: 4, maxBarThickness: 30 }],
    },
    options: baseOpts('%', {
      scales: { x: { grid: { display: false } }, y: { min: 0, max: 100, grid: { color: C.grid }, title: { display: true, text: '% of runners slower' } } },
      plugins: { tooltip: { callbacks: { label: (it: { parsed: { y: number }; dataIndex: number }) => `Faster than ${it.parsed.y}% of runners (${r[it.dataIndex]!.n} with a split)` } } },
    }),
  });
}

function drawLive() {
  const p = rankLog?.points || [];
  if (p.length < 2) return empty('cLive', 'Collecting data, one point every 10 minutes');
  mk('cLive', {
    type: 'line',
    data: {
      labels: p.map(x => ctx.clock.time(Date.parse(x[0]))),
      datasets: [{ label: 'Rank', data: p.map(x => x[1]), borderColor: C.runner, backgroundColor: C.runner, borderWidth: 2, pointRadius: 0, stepped: true }],
    },
    options: baseOpts('rank', {
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { reverse: true, grid: { color: C.grid } } },
      plugins: { tooltip: { callbacks: { label: (it: { parsed: { y: number } }) => `Rank ${it.parsed.y}` } } },
    }),
  });
}

function drawHist(lc: Checkpoint | null) {
  if (!lc || lc.key === 'Start') return empty('cHist', 'No checkpoint passed yet');
  const v = fieldAt(lc.key);
  $('histTitle').textContent = `Arrival time distribution at ${lc.label}`;
  if (v.length < 3) return empty('cHist', 'Not enough runners through this checkpoint yet');
  const lo = Math.floor(Math.min(...v) / HIST_BIN_S), hi = Math.floor(Math.max(...v) / HIST_BIN_S);
  const counts = Array<number>(hi - lo + 1).fill(0);
  v.forEach(x => counts[Math.floor(x / HIST_BIN_S) - lo]!++);
  const mine = Math.floor(at(bib, lc.key)! / HIST_BIN_S) - lo;
  mk('cHist', {
    type: 'bar',
    data: {
      labels: counts.map((_, i) => hm((lo + i) * HIST_BIN_S)),
      datasets: [{ label: 'Runners', data: counts, backgroundColor: counts.map((_, i) => (i === mine ? C.runner : C.bar)), borderRadius: 3, categoryPercentage: 1, barPercentage: 0.92 }],
    },
    options: baseOpts('runners', {
      plugins: {
        tooltip: {
          callbacks: {
            title: (it: { label: string; dataIndex: number }[]) => `${it[0]!.label}–${hm((lo + it[0]!.dataIndex + 1) * HIST_BIN_S)}`,
            label: (it: { parsed: { y: number }; dataIndex: number }) => `${it.parsed.y} runners${it.dataIndex === mine ? ' (incl. ' + short(bib) + ')' : ''}`,
          },
        },
      },
    }),
  });
}

function drawTable(rows: SegmentRow[]) {
  const head = '<tr><th>Checkpoint</th><th>km</th><th>Arrived</th><th>Race time</th><th>Segment</th><th>Pace</th><th>Effort</th><th>Segment median</th><th>Percentile</th><th>Rank at CP</th></tr>';
  const body = CPS.slice(1)
    .map((c, i) => {
      const r = rows[i]!, t = at(bib, c.key);
      if (t == null) return `<tr class="pending"><td>${esc(c.label)}</td><td>${c.km}</td><td colspan="8">–</td></tr>`;
      return `<tr><td>${esc(c.label)}</td><td>${c.km}</td><td>${ctx.clock.dayTime(ctx.track.startMs + t * 1000)}</td><td>${hms(t)}</td><td>${r.t != null ? hms(r.t) : '–'}</td>
      <td>${r.t != null ? mmss(r.t / 60 / r.km) : '–'}</td><td>${mmss(r.pace)}</td><td>${r.med != null ? hms(r.med) : '–'}</td>
      <td>${r.pct != null ? r.pct + '%' : '–'}</td><td>${rankAt(bib, c.key) ?? '–'}</td></tr>`;
    })
    .join('');
  $('tbl').innerHTML = head + body;
}

// ---------- controls ----------
function fillPickers() {
  const list = Object.values(runners).sort((a, b) => (live[a.bib]?.rank || 1e9) - (live[b.bib]?.rank || 1e9));
  $('bibList').innerHTML = list.map(r => `<option value="${esc(r.bib)} · ${esc(r.name)}">`).join('');
  const top = liveOrder.slice(0, 30);
  const sel = $<HTMLSelectElement>('cmp');
  sel.innerHTML =
    `<option value="leader">Leader (live)</option>` + top.filter(b => b !== bib).map(b => `<option value="${esc(b)}">#${live[b]!.rank} · ${esc(short(b))}</option>`).join('');
  if (cmpBib !== 'leader' && !top.includes(cmpBib) && runners[cmpBib]) sel.insertAdjacentHTML('beforeend', `<option value="${esc(cmpBib)}">${esc(short(cmpBib))}</option>`);
  sel.value = cmpBib;
  const input = $<HTMLInputElement>('bibIn');
  if (document.activeElement !== input) input.value = `${bib} · ${nm(bib)}`;
}
const setUrl = () => setUrlParams({ bib, vs: cmpBib === 'leader' ? null : cmpBib });

function bindControls() {
  const input = $<HTMLInputElement>('bibIn');
  input.addEventListener('change', async () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const b = q.split(' ')[0]!;
    const hit = Object.keys(runners).find(k => k.toLowerCase() === b) ?? Object.values(runners).find(r => r.name.toLowerCase().includes(q))?.bib;
    if (!hit) return;
    bib = hit;
    setUrl();
    await loadRankLog();
    fillPickers();
    render();
  });
  input.addEventListener('focus', () => input.select());
  $<HTMLSelectElement>('cmp').addEventListener('change', e => {
    cmpBib = (e.target as HTMLSelectElement).value;
    setUrl();
    render();
  });
}

async function refresh() {
  const needRanks = Date.now() - rankLogAt > RANK_SAMPLE_MS;
  await Promise.all([loadAll(), needRanks ? loadRankLog().then(() => void (rankLogAt = Date.now())) : null]);
  fillPickers();
  render();
}

(async function main() {
  ctx = await loadRaceContext();
  CPS = ctx.track.cps;
  bib ||= ctx.race.defaultBib ?? '';
  bindControls();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})().catch(err => {
  console.error(err);
  $('name').textContent = 'Could not load the race';
  $('sub').textContent = (err as Error).message;
});
