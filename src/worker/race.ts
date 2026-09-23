// The Worker reads the same race.json / route files the pages use, from its static assets,
// so a race is configured in exactly one place.
import { buildTrack, pickContest, type RaceConfig, type RouteData, type Track } from '../shared/race';
import type { Env } from './env';

let race: Promise<RaceConfig> | null = null;
const tracks = new Map<number, Promise<Track>>();

async function asset<T>(env: Env, path: string): Promise<T> {
  const r = await env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
  if (!r.ok) throw new Error(`asset ${path}: ${r.status}`);
  return (await r.json()) as T;
}

export function loadRace(env: Env): Promise<RaceConfig> {
  race ??= asset<RaceConfig>(env, 'race.json').catch(e => {
    race = null;
    throw e;
  });
  return race;
}

export async function loadTrack(env: Env, contestId?: number | string | null): Promise<Track> {
  const r = await loadRace(env);
  const contest = pickContest(r, contestId);
  let t = tracks.get(contest.id);
  if (!t) {
    t = asset<RouteData>(env, contest.track.routeFile).then(route => buildTrack(r, contest, route));
    t.catch(() => tracks.delete(contest.id));
    tracks.set(contest.id, t);
  }
  return t;
}
