// Helpers for the Node scripts.
import fs from 'node:fs';
import path from 'node:path';
import type { RaceConfig } from '../src/shared/race';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** Race id from --race, then the RACE env var (.env), then the only race in races/. */
export function resolveRaceId(id?: string) {
  if (id) return id;
  if (process.env.RACE) return process.env.RACE;
  const all = fs.readdirSync(path.join(ROOT, 'races')).filter(d => fs.existsSync(path.join(ROOT, 'races', d, 'race.json')));
  if (all.length === 1) return all[0]!;
  throw new Error(`set RACE in .env or pass --race (found: ${all.join(', ')})`);
}

export const raceDir = (id: string) => path.join(ROOT, 'races', id);

export function loadRaceFile(id?: string): RaceConfig {
  const dir = raceDir(resolveRaceId(id));
  return JSON.parse(fs.readFileSync(path.join(dir, 'race.json'), 'utf8')) as RaceConfig;
}
