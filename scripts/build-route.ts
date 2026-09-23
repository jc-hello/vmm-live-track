// Builds races/<race>/<routeFile> from a GPX track and the checkpoints in race.json.
//
//   npm run build-route -- <track.gpx> [--race vmm-2026] [--contest 160]
//
// The track is resampled every 25 m with elevation smoothed over ~150 m, and each
// checkpoint is snapped to the point nearest its configured km.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pickContest, type RouteData } from '../src/shared/race';
import { loadRaceFile, raceDir } from './lib';

const STEP_M = 25;
const SMOOTH_HALF_WINDOW = 3; // points each side, so ~150 m

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { race: { type: 'string' }, contest: { type: 'string' } },
});
const gpxPath = positionals[0];
if (!gpxPath) {
  console.error('usage: npm run build-route -- <track.gpx> [--race <id>] [--contest <id>]');
  process.exit(1);
}
const race = loadRaceFile(values.race);
const contest = pickContest(race, values.contest);

const gpx = fs.readFileSync(gpxPath, 'utf8');
const P = [...gpx.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)">\s*<ele>([-\d.]+)/g)].map(m => [+m[1]!, +m[2]!, +m[3]!] as const);
if (P.length < 2) throw new Error(`no <trkpt> with <ele> found in ${gpxPath}`);

const rad = (d: number) => (d * Math.PI) / 180;
function haversine(a: readonly number[], b: readonly number[]) {
  const R = 6371000;
  const [la1, lo1, la2, lo2] = [a[0]!, a[1]!, b[0]!, b[1]!].map(rad) as [number, number, number, number];
  return 2 * R * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
}

const cum = [0];
for (let i = 1; i < P.length; i++) cum.push(cum[i - 1]! + haversine(P[i - 1]!, P[i]!));
const total = cum[cum.length - 1]!;

// resample: [lon, lat, ele, distance]
const out: [number, number, number, number][] = [];
for (let d = 0, j = 0; d <= total; d += STEP_M) {
  while (j < cum.length - 2 && cum[j + 1]! < d) j++;
  const t = (d - cum[j]!) / Math.max(1e-9, cum[j + 1]! - cum[j]!);
  const a = P[j]!, b = P[j + 1]!;
  out.push([a[1] + t * (b[1] - a[1]), a[0] + t * (b[0] - a[0]), a[2] + t * (b[2] - a[2]), d]);
}
const last = P[P.length - 1]!;
out.push([last[1], last[0], last[2], total]);

const eles = out.map(o => o[2]);
const smooth = eles.map((_, i) => {
  const w = eles.slice(Math.max(0, i - SMOOTH_HALF_WINDOW), i + SMOOTH_HALF_WINDOW + 1);
  return w.reduce((s, x) => s + x, 0) / w.length;
});
const gain = [0];
for (let i = 1; i < smooth.length; i++) gain.push(gain[i - 1]! + Math.max(0, smooth[i]! - smooth[i - 1]!));

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const nearest = (km: number) => {
  let best = 0;
  for (let k = 1; k < out.length; k++) if (Math.abs(out[k]![3] / 1000 - km) < Math.abs(out[best]![3] / 1000 - km)) best = k;
  return best;
};

const cps = contest.track.checkpoints.map(c => {
  const i = nearest(c.km ?? total / 1000);
  const [lon, lat, , d] = out[i]!;
  return { key: c.key, label: c.label, km: round(d / 1000, 2), i, lon: round(lon, 6), lat: round(lat, 6), ele: Math.round(smooth[i]!), gain: Math.round(gain[i]!) };
});

const route: RouteData = {
  coords: out.map(o => [round(o[0], 6), round(o[1], 6)]),
  ele: smooth.map(e => Math.round(e)),
  km: out.map(o => round(o[3] / 1000, 3)),
  gain: gain.map(g => Math.round(g)),
  cps,
  totalKm: round(total / 1000, 2),
  totalGain: Math.round(gain[gain.length - 1]!),
};

const file = path.join(raceDir(race.id), contest.track.routeFile);
fs.writeFileSync(file, JSON.stringify(route));
console.log(`${file}: ${out.length} points, ${route.totalKm} km, ${route.totalGain} m D+`);
for (const c of cps) console.log(c.key.padEnd(10), String(c.km).padStart(7), 'km', String(c.ele).padStart(5), 'm', String(c.gain).padStart(5), 'm D+');
