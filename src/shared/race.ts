// Race configuration (races/<id>/race.json) and the route file built from a GPX.
// Everything race-specific lives in these two files; the code is the same for every event.

export interface CheckpointConfig {
  /** raceresult split name, e.g. "CP_M21". "Start" and "Finish" are reserved. */
  key: string;
  label: string;
  /** Short name for charts and tight UI. Defaults to `label`. */
  short?: string;
  /** Distance along the GPX. `null` for Finish means "end of the track". */
  km: number | null;
  /** Draw a marker on the map. Turn off for repeat passes of the same point (laps). */
  onMap?: boolean;
  /** Label the checkpoint on the elevation profile. */
  onProfile?: boolean;
}

export interface LapsConfig {
  name: string;
  description?: string;
  /** Checkpoint keys that bound each lap: [start, end of lap 1, end of lap 2, ...]. */
  checkpoints: string[];
}

export interface TrackConfig {
  /** Route file next to race.json, produced by `npm run build-route`. */
  routeFile: string;
  checkpoints: CheckpointConfig[];
  laps?: LapsConfig;
  /** Extra caveat shown under the map and analytics pages. */
  note?: string;
}

export interface ContestConfig {
  /** raceresult contest id. */
  id: number;
  name: string;
  /** Gun time, ISO 8601 with offset. Required for tracked contests. */
  start?: string;
  /** Contests with a track get the map, analytics and alerts. Others are only logged. */
  track?: TrackConfig;
}

export interface RaceResultConfig {
  server: string;
  eventId: string;
  /** Public key of the event's live page (visible in the organiser's own page source). */
  key: string;
  listName: string;
  /** Some events only answer when origin/referer match the organiser's site. */
  headers?: Record<string, string>;
}

export interface GeoBlockConfig {
  /** Stop blocking at this time (ISO 8601). */
  until: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "VN". */
  country: string;
  /** Region names to block, lowercase without diacritics; matched as substrings. */
  regions: string[];
  /** City names matched exactly, used only when Cloudflare returns no region. */
  cities?: string[];
}

export interface RaceConfig {
  id: string;
  name: string;
  location: string;
  /** IANA time zone used for every clock shown to users. */
  timezone: string;
  /** BCP 47 locale for dates and numbers. Defaults to en-GB. */
  locale?: string;
  defaultBib?: string;
  raceresult: RaceResultConfig;
  /** Map raceresult labels that are not split names, e.g. { "Pre Finish": "Finish" }. */
  labelAliases?: Record<string, string>;
  /** Metres of climb that count as one extra flat km in effort-km. Default 100. */
  climbMetersPerKm?: number;
  contests: ContestConfig[];
  geoBlock?: GeoBlockConfig;
}

export interface RouteCheckpoint {
  key: string;
  label: string;
  km: number;
  /** Index into the route arrays. */
  i: number;
  lon: number;
  lat: number;
  ele: number;
  gain: number;
}

/** Output of scripts/build-route.ts: the track resampled every 25 m. */
export interface RouteData {
  coords: [number, number][];
  ele: number[];
  km: number[];
  gain: number[];
  cps: RouteCheckpoint[];
  totalKm: number;
  totalGain: number;
}

/** A route checkpoint merged with its config entry. */
export interface Checkpoint extends RouteCheckpoint {
  short: string;
  onMap: boolean;
  onProfile: boolean;
  /** Effort-km at this checkpoint. */
  effort: number;
}

export interface Track {
  contest: ContestConfig & { track: TrackConfig; start: string };
  route: RouteData;
  cps: Checkpoint[];
  byKey: Record<string, Checkpoint>;
  /** Effort-km at every route point. */
  effort: number[];
  startMs: number;
}

export const trackedContests = (race: RaceConfig) =>
  race.contests.filter((c): c is ContestConfig & { track: TrackConfig; start: string } => !!c.track && !!c.start);

/** The contest from `?contest=`, or the first tracked one. */
export function pickContest(race: RaceConfig, id?: number | string | null) {
  const tracked = trackedContests(race);
  if (!tracked.length) throw new Error(`race ${race.id} has no contest with a track`);
  return tracked.find(c => String(c.id) === String(id ?? '')) ?? tracked[0]!;
}

/** Effort-km: 1 km plus 1 km for every `climbMetersPerKm` metres climbed. */
export const effortKm = (km: number, gain: number, climbMetersPerKm = 100) => km + gain / climbMetersPerKm;

export function buildTrack(race: RaceConfig, contest: ContestConfig & { track: TrackConfig; start: string }, route: RouteData): Track {
  const conf = Object.fromEntries(contest.track.checkpoints.map(c => [c.key, c]));
  const climb = race.climbMetersPerKm ?? 100;
  const cps = route.cps.map(c => {
    const cfg = conf[c.key];
    return {
      ...c,
      label: cfg?.label ?? c.label,
      short: cfg?.short ?? cfg?.label ?? c.label,
      onMap: cfg?.onMap ?? true,
      onProfile: cfg?.onProfile ?? true,
      effort: effortKm(c.km, c.gain, climb),
    };
  });
  return {
    contest,
    route,
    cps,
    byKey: Object.fromEntries(cps.map(c => [c.key, c])),
    effort: route.km.map((k, i) => effortKm(k, route.gain[i]!, climb)),
    startMs: Date.parse(contest.start),
  };
}
