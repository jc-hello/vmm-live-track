// Shared browser helpers: config loading and small DOM utilities.
import { buildTrack, pickContest, type RaceConfig, type RouteData, type Track } from '../shared/race';
import { configUrl, fetchJson, fetchLiveList, labelMapFor, splitMaps, type SplitConfigResponse } from '../shared/raceresult';
import { clocks } from '../shared/format';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

export const params = new URLSearchParams(location.search);

/** Race config, the selected contest's track, and clocks in the race's time zone. */
export async function loadRaceContext() {
  const race = await fetchJson<RaceConfig>('race.json');
  const contest = pickContest(race, params.get('contest'));
  const route = await fetchJson<RouteData>(contest.track.routeFile);
  const track: Track = buildTrack(race, contest, route);
  const title = `${race.name} · ${contest.name}`;
  document.querySelectorAll('.raceTitle').forEach(el => (el.textContent = title));
  document.title = `${title} · ${document.title}`;
  const note = document.getElementById('trackNote');
  if (note && contest.track.note) note.textContent = contest.track.note;
  return { race, contest, track, clock: clocks(race.timezone, race.locale) };
}

export type RaceContext = Awaited<ReturnType<typeof loadRaceContext>>;

/** label -> split name for the contest, straight from the raceresult live config. */
export async function loadLabelMap({ race, contest }: RaceContext) {
  const cfg = await fetchJson<SplitConfigResponse>(configUrl(race.raceresult));
  return labelMapFor(splitMaps(cfg, race.labelAliases), contest.id, race);
}

export const fetchLive = ({ race, contest }: RaceContext, labelMap: Record<string, string>) =>
  fetchLiveList(race.raceresult, contest.id, labelMap, { cache: 'no-store' });

/** Keep ?bib=, ?vs= and ?contest= in the URL without reloading. */
export function setUrlParams(values: Record<string, string | null>) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(values)) v == null ? u.searchParams.delete(k) : u.searchParams.set(k, v);
  history.replaceState(null, '', u);
}

/** Link to the other page, keeping the contest and bib. */
export function pageLink(page: string, contestId: number, bib: string) {
  const q = new URLSearchParams({ bib });
  if (params.get('contest')) q.set('contest', String(contestId));
  return `${page}?${q}`;
}
