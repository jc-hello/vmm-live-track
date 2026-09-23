// Live map page: every runner on a 3D map, one followed runner in detail.
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './map.css';
import { $, fetchLive, loadLabelMap, loadRaceContext, pageLink, params, setUrlParams, type RaceContext } from './common';
import { estimatePosition, type PositionEstimate } from '../shared/estimate';
import { escapeHtml as esc, hms, shortName } from '../shared/format';
import type { LiveRunner } from '../shared/raceresult';
import type { Checkpoint } from '../shared/race';

const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN ?? '';
const REFRESH_MS = 30_000;
const REDRAW_MS = 5_000; // the estimated dots drift forward between fetches
const STYLES = { outdoors: 'mapbox://styles/mapbox/outdoors-v12', sat: 'mapbox://styles/mapbox/satellite-streets-v12' } as const;
const COLORS = { accent: '#ff5a1f', muted: '#8c9a93', tickOff: '#3a4641' };

let ctx: RaceContext;
let labelMap: Record<string, string> = {};
let bib = params.get('bib') ?? '';
let follow = true;
let rows: LiveRunner[] = [];
let lastFetchOk = 0;
let map: mapboxgl.Map;
let runnerMarker: mapboxgl.Marker;
let confirmedMarker: mapboxgl.Marker;
let styleName: keyof typeof STYLES = 'outdoors';

const estimate = (o: LiveRunner, now: number): PositionEstimate => estimatePosition(ctx.track, o.split, o.elapsed ?? 0, !!o.finished, now);
const cpLabel = (key: string | null) => (key ? ctx.track.byKey[key]?.label ?? key : 'Start');
const geo = (id: string) => map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
const lineSlice = (i0: number, i1: number) => ctx.track.route.coords.slice(Math.max(0, i0), Math.max(i0 + 2, i1 + 1));
const setFollow = (on: boolean) => {
  follow = on;
  $('followBtn').textContent = `Follow: ${on ? 'on' : 'off'}`;
};

// ---------- data ----------
async function loadRows() {
  rows = await fetchLive(ctx, labelMap);
  $('countTxt').textContent = `${rows.length} runners on course`;
  lastFetchOk = Date.now();
}

// ---------- render ----------
function render() {
  const { track, clock } = ctx;
  const { route } = track;
  const now = Date.now();
  const me = rows.find(r => r.bib === bib);
  const stale = now - lastFetchOk > REFRESH_MS * 2.5;
  $('live').classList.toggle('stale', stale);
  $('liveM').classList.toggle('stale', stale);
  $('liveTxt').textContent = $('liveTxtM').textContent = stale ? 'Connection lost' : `Live · ${clock.time(lastFetchOk)}`;

  const top = rows.slice(0, 5);
  $('leaders').innerHTML = top
    .concat(me && !top.includes(me) ? [me] : [])
    .map(
      o => `<li data-bib="${esc(o.bib)}" class="${o.bib === bib ? 'me' : ''}"><span class="pos">${esc(o.rankText)}</span><span class="nm">${esc(o.name)} <span class="muted">${esc(o.nat)}</span></span><span class="cp">${esc(cpLabel(o.split))}<br>${o.elapsed ? hms(o.elapsed) : ''}</span></li>`,
    )
    .join('');

  // every runner on the map
  geo('runners')?.setData({
    type: 'FeatureCollection',
    features: rows.map(o => {
      const e = estimate(o, now);
      return {
        type: 'Feature',
        properties: { bib: o.bib, name: o.name, rank: o.rankText, cp: e.cp.label, me: o.bib === bib ? 1 : 0 },
        geometry: { type: 'Point', coordinates: route.coords[e.i]! },
      };
    }),
  });

  if (!me) {
    $('rName').textContent = bib ? `Bib ${bib}` : 'Pick a runner';
    $('rSub').innerHTML = bib ? `<span class="err">This bib is not on the live list (not started yet, DNF, or another distance).</span>` : '';
    return;
  }
  const e = estimate(me, now);
  const done = e.cp;
  const kmNow = route.km[e.i]!;
  const legKm = (c: Checkpoint) => `+${(c.km - done.km).toFixed(1)} km`;
  $('bibLine').textContent = `Bib ${me.bib} · ${me.nat}${me.club ? ' · ' + me.club : ''}`;
  $('rName').textContent = me.name;
  $('rSub').textContent = me.finished ? 'Finished 🎉' : `On the way to ${e.nextCp ? e.nextCp.label : '—'}`;
  $('sRank').textContent = me.rankText || '–';
  $('sKm').textContent = `${kmNow.toFixed(1)} km`;
  $('sTime').textContent = hms(me.finished ? me.elapsed : (now - track.startMs) / 1000);
  $('prog').style.width = `${(kmNow / route.totalKm) * 100}%`;
  $('progTxt').textContent = `${((kmNow / route.totalKm) * 100).toFixed(1)}% of the course · ${clock.num(route.gain[e.i]!)} / ${clock.num(route.totalGain)} m climbed · ${(route.totalKm - kmNow).toFixed(1)} km to go`;
  $('rLast').textContent = `${done.label} (km ${done.km})`;
  $('rLastAt').textContent = me.elapsed ? `${clock.dayTime(track.startMs + me.elapsed * 1000)} · ${hms(me.elapsed)}` : !me.split ? 'no checkpoint yet' : '–';
  $('rNext').textContent = e.nextCp ? `${e.nextCp.label} (km ${e.nextCp.km}, ${legKm(e.nextCp)})` : '—';
  $('rEta').textContent = e.etaMs ? `~${clock.dayTime(e.etaMs)}${e.overdue ? ' (past expected time)' : ''}` : '—';
  $('rGap').textContent = me.gap || '–';
  $('rGender').textContent = me.genderText || '–';
  $('mNext').textContent = e.nextCp ? `→ ${e.nextCp.label} · ${legKm(e.nextCp)}` : me.finished ? 'Finished' : '–';
  $('mEta').textContent = e.etaMs ? `~${clock.time(e.etaMs)}` : '';
  $('chip').innerHTML = `<b>${esc(shortName(me.name))}</b> <span>· #${esc(me.rankText)} · ${kmNow.toFixed(1)} km</span>${
    e.etaMs && e.nextCp ? ` <em>→ ${esc(e.nextCp.short)} ~${clock.time(e.etaMs)}</em>` : ''
  }`;
  document.querySelectorAll<HTMLAnchorElement>('.toAnalytics').forEach(a => (a.href = pageLink('analytics.html', ctx.contest.id, me.bib)));

  // checkpoint list
  const doneIdx = track.cps.indexOf(done);
  $('cpList').innerHTML = track.cps
    .map((c, k) => {
      const cls = k <= doneIdx ? 'done' : k === doneIdx + 1 ? 'next' : '';
      const t = k === doneIdx && me.elapsed ? hms(me.elapsed) : k === doneIdx + 1 && e.etaMs ? '~' + clock.time(e.etaMs) : '';
      return `<li class="${cls}"><i class="dot"></i><span>${esc(c.label)}</span><span class="km">${c.km} km</span><span class="t">${t}</span></li>`;
    })
    .join('');

  // map: covered part + markers
  geo('done')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: lineSlice(0, e.i) } });
  geo('ahead')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: e.nextCp ? lineSlice(done.i, e.nextCp.i) : [] } });
  const ll = route.coords[e.i]!;
  runnerMarker.setLngLat(ll).addTo(map);
  runnerMarker.getElement().querySelector('.runner-tag')!.textContent = `${me.bib} · ${shortName(me.name)}`;
  confirmedMarker.setLngLat([done.lon, done.lat]).addTo(map);
  if (follow) map.easeTo({ center: ll, padding: mapPadding(), duration: 900 });
  drawProfile(e.i, doneIdx);
  if (isMobile() && sheetState === 'peek') setSheet('peek'); // the card height changes once data arrives
}

/** Round km step so the profile gets at most `max` labels. */
const kmStep = (total: number, max: number) => [5, 10, 20, 25, 40, 50, 100, 200].find(s => total / s <= max) ?? 500;

function drawProfile(iNow: number, doneIdx: number) {
  const { route, cps } = ctx.track;
  const svg = $('profile') as unknown as SVGSVGElement;
  const W = svg.clientWidth || 800, H = svg.clientHeight || 130;
  const padB = 18, padT = 16;
  const { ele, km } = route, n = ele.length;
  const minE = Math.min(...ele) - 50, maxE = Math.max(...ele) + 50;
  const x = (k: number) => (k / route.totalKm) * W;
  const y = (e: number) => padT + (1 - (e - minE) / (maxE - minE)) * (H - padT - padB);
  const pt = (i: number) => `${x(km[i]!).toFixed(1)},${y(ele[i]!).toFixed(1)}`;
  const step = Math.max(1, Math.floor(n / W));
  const pts: string[] = [];
  for (let i = 0; i < n; i += step) pts.push(pt(i));
  const all = `M0,${H - padB} L${pts.join(' L')} L${W},${H - padB} Z`;
  const dp: string[] = [];
  for (let i = 0; i <= iNow; i += step) dp.push(pt(i));
  dp.push(pt(iNow));
  const doneP = `M0,${H - padB} L${dp.join(' L')} L${x(km[iNow]!).toFixed(1)},${H - padB} Z`;
  const ticks = cps
    .map((c, k) => `<line x1="${x(c.km)}" x2="${x(c.km)}" y1="${padT - 4}" y2="${H - padB}" stroke="${k <= doneIdx ? COLORS.accent : COLORS.tickOff}" stroke-dasharray="2 3"/>`)
    .join('');
  let lastEnd = -1;
  const labels = cps
    .filter(c => c.onProfile)
    .map(c => {
      const x0 = x(c.km) + 2;
      if (x0 < lastEnd) return '';
      lastEnd = x0 + c.short.length * 5.6 + 6;
      return `<text x="${x0}" y="${padT - 5}" font-size="9.5" fill="${COLORS.muted}">${esc(c.short)}</text>`;
    })
    .join('');
  const s = kmStep(route.totalKm, W < 500 ? 4 : 8);
  const kmTicks: string[] = [];
  for (let k = 0; k <= route.totalKm; k += s) kmTicks.push(`<text x="${x(k) + 2}" y="${H - 4}" font-size="10" fill="${COLORS.muted}" font-family="JetBrains Mono">${k}</text>`);
  const xi = x(km[iNow]!), yi = y(ele[iNow]!);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.accent}" stop-opacity=".75"/><stop offset="1" stop-color="${COLORS.accent}" stop-opacity=".08"/></linearGradient></defs>
    <path d="${all}" fill="#1e2724" stroke="#56655f" stroke-width="1"/>
    <path d="${doneP}" fill="url(#g1)" stroke="${COLORS.accent}" stroke-width="1.5"/>
    ${ticks}${labels}${kmTicks.join('')}
    <line x1="${xi}" x2="${xi}" y1="${padT}" y2="${H - padB}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="${xi}" cy="${yi}" r="5" fill="${COLORS.accent}" stroke="#fff" stroke-width="2"/>
    <text x="${Math.min(W - 110, xi + 8)}" y="${Math.max(padT + 20, yi - 8)}" font-size="11" font-weight="700" fill="#fff">${km[iNow]!.toFixed(1)} km · ${ele[iNow]} m</text>`;
}

// ---------- layout (desktop sidebar / mobile bottom sheet) ----------
const mq = matchMedia('(max-width: 820px)');
const isMobile = () => mq.matches;
type SheetState = 'peek' | 'full';
let sheetState: SheetState = 'peek';

function peekHeight() {
  // peek: down to the end of the runner card's progress bar (offsetParent is the sheet)
  const t = $('progTxt');
  return Math.min(window.innerHeight * 0.55, t.offsetTop + t.offsetHeight + 16);
}
const sheetPx = (state: SheetState) => (state === 'full' ? window.innerHeight * 0.88 : peekHeight());
function setSheet(state: SheetState) {
  sheetState = state;
  const side = $('sheet');
  side.classList.toggle('expanded', state === 'full');
  if (state !== 'full') side.scrollTop = 0;
  document.documentElement.style.setProperty('--sheet-h', sheetPx(state) + 'px');
}
function mapPadding(): mapboxgl.PaddingOptions {
  if (document.body.classList.contains('fullmap')) return { top: 60, bottom: 70, left: 20, right: 20 };
  if (isMobile()) return { top: 60, bottom: peekHeight() + 10, left: 20, right: 20 };
  return { top: 60, bottom: 170, left: 410, right: 60 };
}
function placeProfile() {
  // mobile: the elevation profile sits in the sheet right under the runner card
  const pc = $('profileCard');
  if (isMobile()) $('runnerCard').after(pc);
  else document.querySelector('.app')!.appendChild(pc);
}
function initSheet() {
  const side = $('sheet'), handle = $('handle');
  let y0: number | null = null, h0 = 0, moved = false;
  const clientY = (ev: TouchEvent | MouseEvent) => ('touches' in ev ? ev.touches[0]!.clientY : ev.clientY);
  const onHandle = (ev: Event) => !!(ev.target as Element | null)?.closest('.handle');
  const start = (ev: TouchEvent | MouseEvent) => {
    if (!isMobile()) return;
    if (sheetState === 'full' && side.scrollTop > 0 && !onHandle(ev)) return;
    y0 = clientY(ev);
    h0 = side.getBoundingClientRect().height;
    moved = false;
  };
  const move = (ev: TouchEvent | MouseEvent) => {
    if (y0 === null) return;
    const dy = clientY(ev) - y0;
    if (sheetState === 'full' && dy < 0 && !onHandle(ev)) {
      y0 = null; // let the content scroll
      return;
    }
    if (Math.abs(dy) < 6) return;
    moved = true;
    side.classList.add('dragging');
    const h = Math.max(120, Math.min(window.innerHeight * 0.92, h0 - dy));
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
    if (ev.cancelable) ev.preventDefault();
  };
  const end = () => {
    if (y0 === null) return;
    side.classList.remove('dragging');
    const h = side.getBoundingClientRect().height;
    if (moved) setSheet(h > (sheetPx('peek') + sheetPx('full')) / 2 ? 'full' : 'peek');
    y0 = null;
  };
  side.addEventListener('touchstart', start, { passive: true });
  side.addEventListener('touchmove', move, { passive: false });
  side.addEventListener('touchend', end);
  handle.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  handle.addEventListener('click', () => {
    if (!moved && isMobile()) setSheet(sheetState === 'full' ? 'peek' : 'full');
  });
  const apply = () => {
    placeProfile();
    if (isMobile()) setSheet(sheetState);
    else document.documentElement.style.removeProperty('--sheet-h');
  };
  mq.addEventListener('change', () => {
    apply();
    if (rows.length) render();
  });
  apply();
}

// ---------- map ----------
function addLayers() {
  const { route, cps } = ctx.track;
  if (!map.getSource('dem')) map.addSource('dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
  map.setTerrain({ source: 'dem', exaggeration: 1.4 });
  const line = (coordinates: [number, number][]): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } });
  map.addSource('route', { type: 'geojson', data: line(route.coords) });
  map.addSource('done', { type: 'geojson', data: line([]) });
  map.addSource('ahead', { type: 'geojson', data: line([]) });
  map.addSource('cps', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: cps
        .filter(c => c.onMap)
        .map(c => ({
          type: 'Feature',
          properties: { label: c.label, km: c.km, ele: c.ele, start: c.key === 'Start' || c.key === 'Finish' ? 1 : 0 },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        })),
    },
  });
  map.addSource('runners', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const round = { 'line-join': 'round', 'line-cap': 'round' } as const;
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#111', 'line-width': 6, 'line-opacity': 0.55 }, layout: round });
  map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ffd9c7', 'line-width': 3 }, layout: round });
  map.addLayer({ id: 'ahead', type: 'line', source: 'ahead', paint: { 'line-color': '#ffb020', 'line-width': 4, 'line-dasharray': [1, 1.5] }, layout: { 'line-join': 'round' } });
  map.addLayer({ id: 'done', type: 'line', source: 'done', paint: { 'line-color': COLORS.accent, 'line-width': 4.5 }, layout: round });
  map.addLayer({
    id: 'runners',
    type: 'circle',
    source: 'runners',
    filter: ['==', ['get', 'me'], 0],
    paint: { 'circle-radius': 4.5, 'circle-color': '#4da3ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.85 },
  });
  map.addLayer({
    id: 'cps',
    type: 'circle',
    source: 'cps',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'start'], 1], 8, 6],
      'circle-color': ['case', ['==', ['get', 'start'], 1], '#111', '#fff'],
      'circle-stroke-color': '#111',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'cp-labels',
    type: 'symbol',
    source: 'cps',
    layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'] },
    paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
  });

  const pointOf = (f: GeoJSON.Feature) => (f.geometry as GeoJSON.Point).coordinates as [number, number];
  const popup = new mapboxgl.Popup({ closeButton: false, offset: 10 });
  map.on('mouseenter', 'runners', ev => {
    const f = ev.features?.[0];
    if (!f) return;
    map.getCanvas().style.cursor = 'pointer';
    const p = f.properties!;
    popup.setLngLat(pointOf(f)).setHTML(`<b>${esc(p.bib)} · ${esc(p.name)}</b><br>Rank ${esc(p.rank)} · passed ${esc(p.cp)}<br><span style="color:${COLORS.muted}">Click to follow</span>`).addTo(map);
  });
  map.on('mouseleave', 'runners', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
  map.on('click', 'runners', ev => {
    const b = ev.features?.[0]?.properties?.bib;
    if (b != null) setBib(String(b));
  });
  map.on('click', 'cps', ev => {
    const f = ev.features?.[0];
    if (!f) return;
    const p = f.properties!;
    new mapboxgl.Popup({ offset: 10 }).setLngLat(pointOf(f)).setHTML(`<b>${esc(p.label)}</b><br>km ${p.km} · ${p.ele} m`).addTo(map);
  });
  if (rows.length) render();
}

function setBib(b: string) {
  bib = b.trim();
  setUrlParams({ bib });
  setFollow(true);
  render();
  const r = rows.find(x => x.bib === bib);
  if (r) map.flyTo({ center: ctx.track.route.coords[estimate(r, Date.now()).i]!, zoom: 13.5, pitch: 55, padding: mapPadding(), duration: 1500 });
  if (isMobile()) setSheet('peek');
}

async function tick() {
  try {
    await loadRows();
  } catch (err) {
    console.warn(err);
  }
  render();
}

async function main() {
  if (!MAPBOX_TOKEN) {
    document.body.innerHTML = `<div class="setup">Missing Mapbox token.<br>Set <code>VITE_MAPBOX_TOKEN</code> in <code>.env</code> and rebuild.</div>`;
    return;
  }
  ctx = await loadRaceContext();
  const { race, track } = ctx;
  bib ||= race.defaultBib ?? '';
  // start the live data requests now; the map can take a while to build its first frame
  const dataReady = loadLabelMap(ctx)
    .then(m => (labelMap = m))
    .catch(err => console.warn(err))
    .then(loadRows)
    .catch(err => console.warn(err));
  $('raceLocation').textContent = race.location;
  $('routeMeta').textContent = `${track.route.totalKm} km · ${ctx.clock.num(track.route.totalGain)} m D+`;

  mapboxgl.accessToken = MAPBOX_TOKEN;
  initSheet();
  const coords = track.route.coords;
  const bounds = coords.reduce((bb, c) => bb.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
  map = new mapboxgl.Map({ container: 'map', style: STYLES.outdoors, bounds, fitBoundsOptions: { padding: mapPadding() }, pitch: 45, bearing: -10, attributionControl: true });
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), isMobile() ? 'bottom-right' : 'top-right');
  const el = document.createElement('div');
  el.className = 'runner-marker';
  el.innerHTML = '<div class="runner-tag"></div>';
  runnerMarker = new mapboxgl.Marker({ element: el });
  const c = document.createElement('div');
  c.className = 'confirmed-marker';
  confirmedMarker = new mapboxgl.Marker({ element: c });
  map.on('style.load', addLayers);
  map.on('dragstart', () => setFollow(false));

  $('styleBtn').onclick = () => {
    styleName = styleName === 'outdoors' ? 'sat' : 'outdoors';
    $('styleBtn').textContent = styleName === 'outdoors' ? 'Satellite' : 'Terrain';
    map.setStyle(STYLES[styleName]);
  };
  const toggleFull = () => {
    document.body.classList.toggle('fullmap');
    setTimeout(() => {
      map.resize();
      render();
    }, 50);
  };
  $('fullBtn').onclick = toggleFull;
  $('chip').onclick = toggleFull;
  if (params.get('full') === '1') document.body.classList.add('fullmap');
  $('followBtn').onclick = () => {
    setFollow(!follow);
    if (follow) render();
  };
  $('leaders').onclick = ev => {
    const li = (ev.target as Element).closest('li');
    if (li?.dataset.bib) setBib(li.dataset.bib);
  };
  $('bibForm').onsubmit = ev => {
    ev.preventDefault();
    const q = $<HTMLInputElement>('bibInput').value.trim().toLowerCase();
    if (!q) return;
    const hit = rows.find(r => r.bib.toLowerCase() === q) || rows.find(r => r.name.toLowerCase().includes(q));
    $('searchMsg').textContent = hit ? `→ ${hit.bib} · ${hit.name}` : 'Not found on the live list.';
    if (hit) setBib(hit.bib);
  };
  window.addEventListener('resize', () => {
    if (isMobile()) setSheet(sheetState);
    if (rows.length) render();
  });

  await dataReady;
  render();
  setInterval(tick, REFRESH_MS);
  setInterval(render, REDRAW_MS);
}

main().catch(err => {
  console.error(err);
  $('rName').textContent = 'Could not load the race';
  $('rSub').innerHTML = `<span class="err">${esc((err as Error).message)}</span>`;
});
