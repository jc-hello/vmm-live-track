// Optional, temporary geo block (race.json `geoBlock`): visitors whose IP geolocates to
// the listed regions get a plain 404 until `until`. Everyone else passes through.
// Needs `run_worker_first = true` in wrangler.toml so the Worker sees page requests too.
import type { GeoBlockConfig } from '../shared/race';
import type { Env } from './env';

const PASS_COOKIE = 'tracker_pass';

interface Geo {
  country?: string;
  region?: string;
  regionCode?: string;
  city?: string;
  colo?: string;
}

/** Lowercase, strip diacritics (incl. Vietnamese đ). */
const norm = (s: unknown) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();

// Match on region NAMES only: Cloudflare's regionCode doesn't always follow ISO 3166-2
// (Lào Cai comes back as "15", ISO says "02"), so codes can block the wrong region.
export function isBlockedRegion(cfg: GeoBlockConfig, cf: Geo | undefined) {
  if (!cf || cf.country !== cfg.country) return false;
  const region = norm(cf.region);
  if (region) return cfg.regions.some(n => region.includes(n));
  // No region: fall back to an exact city match ("vinh" must not catch "vinh phuc").
  const cities = new Set(cfg.cities ?? []);
  const city = norm(cf.city).replace(/^(thanh pho|tp\.?|city of)\s+/, '').replace(/\s+city$/, '').trim();
  return cities.has(city) || cities.has(norm(cf.city));
}

const blocking = (cfg: GeoBlockConfig, cf: Geo | undefined, now = Date.now()) => now < Date.parse(cfg.until) && isBlockedRegion(cfg, cf);

export const notFoundPage = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · Page not found</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#222;font-family:system-ui,sans-serif}
main{text-align:center;padding:24px}h1{font-size:64px;margin:0;color:#bbb}p{color:#666}</style></head>
<body><main><h1>404</h1><p>The page you are looking for does not exist.</p></main></body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

function gate(cfg: GeoBlockConfig, request: Request, env: Env, cf: Geo | undefined): Response | null {
  const url = new URL(request.url);
  const cookie = request.headers.get('cookie') || '';
  // Bypass link /?pass=<BYPASS_TOKEN> sets a cookie, so a mis-geolocated phone (mobile
  // IPs often resolve to a gateway in another region) still gets through.
  if (env.BYPASS_TOKEN && url.searchParams.get('pass') === env.BYPASS_TOKEN) {
    url.searchParams.delete('pass');
    const maxAge = Math.max(60, Math.ceil((Date.parse(cfg.until) - Date.now()) / 1000));
    return new Response(null, {
      status: 302,
      headers: {
        location: url.pathname + url.search,
        'set-cookie': `${PASS_COOKIE}=${env.BYPASS_TOKEN}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }
  if (env.BYPASS_TOKEN && cookie.includes(`${PASS_COOKIE}=${env.BYPASS_TOKEN}`)) return null;
  return blocking(cfg, cf) ? notFoundPage() : null;
}

/**
 * Returns a response when the request must not reach the site, otherwise null.
 * `/__geo?key=<GEO_DEBUG_KEY>` shows how Cloudflare geolocates the caller;
 * add `&simulate=<region>[&city=<city>]` to test a region, and `&render=1` to see its page.
 */
export function geoGate(cfg: GeoBlockConfig | undefined, request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const cf = request.cf as Geo | undefined;
  if (url.pathname === '/__geo') {
    if (!cfg || !env.GEO_DEBUG_KEY || url.searchParams.get('key') !== env.GEO_DEBUG_KEY) return notFoundPage();
    const sim = url.searchParams.get('simulate');
    const geo: Geo = sim != null ? { country: cfg.country, region: sim, city: url.searchParams.get('city') || undefined } : cf || {};
    if (sim != null && url.searchParams.get('render') === '1') {
      const plain = new Request(new URL('/', url), { headers: request.headers });
      return gate(cfg, plain, env, geo) || new Response(`ALLOWED: ${sim} would see the normal site`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const { country, region, regionCode, city, colo } = geo;
    return Response.json({
      simulated: sim != null,
      country,
      region,
      regionCode,
      city,
      colo,
      blockedRegion: isBlockedRegion(cfg, geo),
      blockUntil: cfg.until,
      blockingNow: blocking(cfg, geo),
    });
  }
  return cfg ? gate(cfg, request, env, cf) : null;
}
