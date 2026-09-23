# vmm-tracker

Live tracking for trail races timed by [raceresult](https://www.raceresult.com): a 3D map with every runner's estimated position, per-runner pacing and fatigue analytics, and email alerts when a followed runner passes a checkpoint, falls behind schedule or drops off the live list.

It was built for **VMM 2026** (Vietnam Mountain Marathon, 100 miles) and works for any raceresult event: each race is one config folder, and the code is the same for every event.

- **Map** (`/`): all runners on a Mapbox 3D terrain map. A runner's position between checkpoints is interpolated from their own effort-km pace. The page also shows the elevation profile, ETA to the next checkpoint and the top 5.
- **Analytics** (`/analytics.html`): race time vs. the field's median and middle 50%, segment pace in min/effort-km, a fatigue index, lap comparison, segment percentiles, rank history, arrival histogram and a splits table.
- **Logger**: a Durable Object polls the live lists every 30 s and writes every checkpoint passing to Cloudflare D1. raceresult only shows each runner's *latest* checkpoint, so this log is how full split histories exist at all.
- **Alerts** (optional): email through [Resend](https://resend.com) when a followed bib passes a CP, is overdue, disappears (possible DNF), or the logger itself fails.

Everything runs on Cloudflare's free tier: one Worker (site + API + logger) and one D1 database.

## How it works

```
raceresult live list ──► Poller (Durable Object, every 30 s) ──► D1: runners, passings, snapshots, cache
        │                                                              │
        └──────── browser (live positions) ◄── Worker: static site + /api/field, /api/ranklog ◄┘
```

*Effort-km* = km + metres climbed ÷ 100, so a climbing segment and a flat one compare fairly. ETAs use the runner's race-average effort pace, 4% slower.

## Project layout

```
races/<race-id>/         race.json (config) + route-<contest>.json (built from GPX)
src/shared/              code used by the browser, the Worker and the scripts
  race.ts                config types, effort-km, track model
  raceresult.ts          raceresult URLs and live-list parsing
  events.ts              poll diffing -> SQL statements
  estimate.ts            position / ETA estimation
src/worker/              Cloudflare Worker: API, Poller Durable Object, alerts, geo gate
src/web/                 map and analytics pages (TypeScript + CSS)
web/                     HTML entry points (Vite root)
scripts/                 build-route, local-logger, backfill
migrations/              D1 schema
test/                    unit tests (Vitest)
```

## Quick start

Requirements: Node 22+, a Cloudflare account, and a [Mapbox access token](https://account.mapbox.com/).

```bash
npm install
cp .env.example .env                    # set VITE_MAPBOX_TOKEN (and RACE)
cp .dev.vars.example .dev.vars          # local Worker secrets
cp wrangler.example.toml wrangler.toml
```

Run locally:

```bash
npm run db:migrate:local
npm run dev:worker                      # builds the site, serves site + API + logger on :8787
curl "http://localhost:8787/logger/start?key=<CONTROL_KEY>"   # start polling
```

For frontend work, run `npm run dev` (Vite, hot reload) next to `npm run dev:worker`. Vite proxies `/api` to the Worker.

## Deploy

```bash
npx wrangler d1 create race-tracker        # paste the database_id into wrangler.toml
npm run db:migrate
npx wrangler secret put CONTROL_KEY
npm run deploy
curl "https://<your-worker>/logger/start?key=<CONTROL_KEY>"
```

Logger controls (all but `status` need `?key=<CONTROL_KEY>`):

| Path | |
| --- | --- |
| `/logger/status` | health, last poll, alert state |
| `/logger/start` | start the 30 s polling loop |
| `/logger/stop` | stop it |
| `/logger/reload` | rebuild the in-memory state and the API cache from the D1 tables |

API: `/api/field?contest=<id>` (all runners + passings), `/api/ranklog?contest=<id>&bib=<bib>` (live rank every 10 min), `/api/health`.

### Email alerts

Set the vars `WATCH_BIBS` (comma-separated), `ALERT_TO` and `ALERT_FROM` (a sender on a domain verified in Resend) in `wrangler.toml`, then `npx wrangler secret put RESEND_API_KEY`. Alerts stay off while any of the four is missing. Set `SITE_URL` so emails link to the map.

## Add a new race

1. **Find the raceresult live page.** Open the organiser's live results, then in the browser dev tools look for requests to `https://<server>.raceresult.com/<eventId>/live/list?key=...`. That gives you `server`, `eventId`, `key` and the `listname`. The key is public: it is in the organiser's own page source. Open `.../live/config?key=...&page=live` to see the contests and their split names (`splits[].Name` / `Label`).
2. **Create `races/<your-race>/race.json`**, starting from [`races/vmm-2026/race.json`](races/vmm-2026/race.json):
   - `contests`: every contest to log. Add `start` and `track` to the contests that should get a map and analytics.
   - `track.checkpoints`: one entry per raceresult split, **keys = split names**, in course order, with the km along the GPX. `Start` and `Finish` are reserved keys; Finish can use `"km": null` for the end of the track.
   - `onMap: false` / `onProfile: false` hide repeat passes of the same point, such as laps. `short` sets the name shown in charts.
   - `laps` (optional) enables the lap-comparison chart.
   - `labelAliases` maps raceresult labels that are not split names (e.g. `"Pre Finish": "Finish"`).
   - `timezone` / `locale` control every clock shown to users.
3. **Build the route** from the course GPX (it must contain `<ele>`):
   ```bash
   npm run build-route -- path/to/course.gpx --race <your-race> --contest <id>
   ```
   Check the printed checkpoint table: each CP's elevation and D+ should match the official course profile.
4. Set `RACE=<your-race>` in `.env`, then build and deploy. Use one Worker + D1 database per race (copy `wrangler.toml` with a different `name`), so old races stay online untouched.

### Before the Worker is deployed

`npm run local-logger` polls from your machine into `logs/*.jsonl`. `npm run backfill` later replays those files through the same diff logic into `backfill.sql` for `wrangler d1 execute <db> --remote --file backfill.sql`.

### Geo gate (optional)

`race.json` can hold a temporary `geoBlock` (`until`, `country`, `regions`, `cities`) that returns a 404 to visitors from the listed regions. It needs `run_worker_first = true` in `wrangler.toml`. Visitors can bypass it with `/?pass=<BYPASS_TOKEN>`, and `/__geo?key=<GEO_DEBUG_KEY>&simulate=<region>` tests the rules.

## Development

```bash
npm run typecheck    # web, worker and node projects
npm test             # unit tests
npm run check        # typecheck + test + build
```

## Notes and limits

- raceresult publishes only each runner's **latest** checkpoint. Splits passed before the logger started are lost, apart from whatever `local-logger` + `backfill` captured.
- raceresult re-times a checkpoint about 20 s after first showing it (second mat read). The logger follows those corrections.
- Positions between checkpoints are estimates, not GPS.
- This project is not affiliated with raceresult, Mapbox or any race organiser. Respect each event's terms and keep the polling interval reasonable.

## License

[MIT](LICENSE)
