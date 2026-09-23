import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const ROOT = import.meta.dirname;

// RACE picks races/<RACE>/, whose race.json and route files are served as-is at the site root.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  const race = env.RACE || 'vmm-2026';
  const raceDir = path.join(ROOT, 'races', race);
  if (!fs.existsSync(path.join(raceDir, 'race.json'))) throw new Error(`races/${race}/race.json not found (check RACE in .env)`);

  return {
    root: path.join(ROOT, 'web'),
    envDir: ROOT,
    publicDir: raceDir,
    build: {
      outDir: path.join(ROOT, 'dist'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 2500, // mapbox-gl alone is ~1.8 MB
      rollupOptions: {
        input: {
          index: path.join(ROOT, 'web/index.html'),
          analytics: path.join(ROOT, 'web/analytics.html'),
        },
      },
    },
    server: {
      // the API and logger run in `wrangler dev` (npm run dev:worker)
      proxy: { '/api': 'http://localhost:8787', '/logger': 'http://localhost:8787' },
    },
  };
});
