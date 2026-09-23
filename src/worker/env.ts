import type { Poller } from './poller';

export interface Env {
  DB: D1Database;
  POLLER: DurableObjectNamespace<Poller>;
  /** Static assets (the built site, including race.json and the route files). */
  ASSETS: Fetcher;

  /** Protects /logger/start, /logger/stop and /logger/reload. */
  CONTROL_KEY?: string;
  /** Public URL of the site, used for links in alert emails. */
  SITE_URL?: string;

  // Email alerts (optional; all four must be set to enable them)
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
  /** Comma-separated recipients. */
  ALERT_TO?: string;
  /** Comma-separated bibs to follow. */
  WATCH_BIBS?: string;
  /** Contest of the watched bibs. Defaults to the first tracked contest. */
  WATCH_CONTEST?: string;

  // Geo gate (optional, see race.json `geoBlock`)
  BYPASS_TOKEN?: string;
  GEO_DEBUG_KEY?: string;
}
