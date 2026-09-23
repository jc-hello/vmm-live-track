// One Worker serves the site (static assets), the read-only API and the logger controls.
//   /api/*            read-only JSON (see api.ts)
//   /logger/status    public health of the poller
//   /logger/start|stop|reload?key=<CONTROL_KEY>
import type { Env } from './env';
import { handleApi } from './api';
import { geoGate } from './geo-gate';
import { loadRace } from './race';

export { Poller } from './poller';

const LOGGER_ROUTES = ['/logger/status', '/logger/start', '/logger/stop', '/logger/reload'];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const race = await loadRace(env);

    const blocked = geoGate(race.geoBlock, request, env);
    if (blocked) return blocked;

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
      return handleApi(request, env);
    }

    if (LOGGER_ROUTES.includes(url.pathname)) {
      const control = url.pathname !== '/logger/status';
      if (control && (!env.CONTROL_KEY || url.searchParams.get('key') !== env.CONTROL_KEY)) return new Response('forbidden', { status: 403 });
      const stub = env.POLLER.get(env.POLLER.idFromName('main'));
      return stub.fetch(new Request(new URL(url.pathname.replace('/logger', ''), url.origin)));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
