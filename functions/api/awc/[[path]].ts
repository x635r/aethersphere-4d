/**
 * Cloudflare Pages Function: /api/awc/*
 *
 * Two upstreams need a same-origin proxy for different reasons:
 *
 *  - AviationWeather.gov sends no CORS headers and rejects requests without a
 *    self-identifying User-Agent, so a browser cannot reach it at all.
 *  - OpenSky answers with `Access-Control-Allow-Origin: https://opensky-network.org`,
 *    which blocks every other origin — direct browser calls fail with an opaque
 *    "Failed to fetch" rather than a status code.
 *
 * Both are normalised here behind one endpoint so the client needs no special
 * cases and the User-Agent requirement is satisfied in one place.
 */

const AWC_UPSTREAM = 'https://aviationweather.gov/api/data';
const OPENSKY_UPSTREAM = 'https://opensky-network.org/api';
const USER_AGENT =
  'AetherSphere4D-Weather-Twin/1.0 (https://aethersphere.pages.dev)';
const CACHE_SECONDS = 120;

/** OpenSky rate limits aggressively; a 15 s edge cache blunts accidental bursts. */
const OPENSKY_CACHE_SECONDS = 15;

interface PagesContext {
  request: Request;
  params: { path?: string | string[] };
  waitUntil: (promise: Promise<unknown>) => void;
}

interface Env {
  ASSETS?: unknown;
}

/** Minimal shape of the Cache API, which is not part of the standard lib types. */
interface CacheStorageLike {
  default: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
}

const ALLOWED_ENDPOINTS = new Set([
  'isigmet',
  'gairmet',
  'metar',
  'taf',
  'pirep',
  'airmet',
  'airsigmet',
  // OpenSky paths are prefixed so they cannot collide with AWC names.
  'opensky/states/all',
]);

function badRequest(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: true, reason: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet(
  context: PagesContext,
): Promise<Response> {
  const { request, params } = context;

  const rawPath = params.path;
  const segments = Array.isArray(rawPath)
    ? rawPath
    : (rawPath ?? '').split('/').filter(Boolean);

  const endpoint = segments.join('/');
  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return badRequest(
      `Unsupported proxy endpoint "${endpoint}". ` +
        `Allowed: ${[...ALLOWED_ENDPOINTS].join(', ')}.`,
    );
  }

  const isOpenSky = endpoint.startsWith('opensky/');
  const incoming = new URL(request.url);

  // OpenSky paths already include their own prefix and must not be re-prefixed
  // with the AWC data root.
  const upstreamUrl = isOpenSky
    ? new URL(`${OPENSKY_UPSTREAM}/${endpoint.replace(/^opensky\//, '')}`)
    : new URL(`${AWC_UPSTREAM}/${endpoint}`);

  // Forward query parameters verbatim (bbox, format, lamin/lomin/...).
  incoming.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  // AWC defaults to raw text; GeoJSON is what the map layers consume. OpenSky
  // always returns JSON and rejects an unknown `format` parameter.
  if (!isOpenSky && !upstreamUrl.searchParams.has('format')) {
    upstreamUrl.searchParams.set('format', 'geojson');
  }

  const cacheSeconds = isOpenSky ? OPENSKY_CACHE_SECONDS : CACHE_SECONDS;

  const cacheKey = new Request(upstreamUrl.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const cache = (globalThis as { caches?: CacheStorageLike }).caches;

  if (cache) {
    try {
      const cached = await cache.default.match(cacheKey);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set('X-AetherSphere-Cache', 'HIT');
        return hit;
      }
    } catch {
      // Cache API unavailable in some runtimes; fall through to network.
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      redirect: 'follow',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    return badRequest(`Upstream request failed: ${reason}`, 502);
  }

  if (!upstream.ok) {
    return badRequest(
      `Upstream responded ${upstream.status} ${upstream.statusText}`,
      502,
    );
  }

  const body = await upstream.arrayBuffer();

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type':
        upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
      'Access-Control-Allow-Origin': '*',
      'X-AetherSphere-Cache': 'MISS',
      'X-AetherSphere-Proxy': 'cloudflare-pages',
    },
  });

  if (cache) {
    const cacheable = response.clone();
    context.waitUntil(
      cache.default
        .put(cacheKey, cacheable)
        .catch(() => undefined),
    );
  }

  return response;
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '600',
    },
  });
}

export type { Env };
