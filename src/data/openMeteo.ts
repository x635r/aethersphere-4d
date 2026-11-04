/**
 * Open-Meteo client.
 *
 * Two upstream realities shape this module:
 *
 * 1. The free tier bills **one API call per coordinate**, and enforces roughly
 *    a 600-call minute budget (a burst of ~6 requests, each carrying many
 *    coordinates, trips it). A full globe grid therefore has to be chunked into
 *    as few requests as possible: each request carries up to POINTS_PER_REQUEST
 *    coordinate pairs. A 288-point grid is 2 requests, i.e. 288 billed calls.
 *
 * 2. The API rejects request URIs over ~8 KB (HTTP 414), which caps how many
 *    coordinates and variables can travel together. Points-per-request is tuned
 *    so that one level's variable set stays under that ceiling.
 *
 * Everything is cached by (level, scalar, time window) so switching levels or
 * scrubbing the timeline does not re-spend the minute budget.
 */

import type { GridSpec, RawLocationPayload } from '../core/types';
import type { ScalarFieldId } from '../core/levels';
import { hasQuotaFor, noteUpstreamSpend, quotaSnapshot } from './quota';

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const MARINE_BASE = 'https://marine-api.open-meteo.com/v1/marine';
const AIR_QUALITY_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ENSEMBLE_BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';

/** Coordinates per HTTP request. Keeps the URI under nginx's 414 threshold. */
const POINTS_PER_REQUEST = 150;

/**
 * Quota accounting lives in `./quota` because Stage 2's sounding and transect
 * fetchers draw from the same upstream budget. Re-exported here so existing
 * callers keep a single import site.
 */

export { quotaSnapshot as budgetSnapshot } from './quota';
const memoryCache = new Map<string, { at: number; data: RawLocationPayload[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;

function cacheGet(key: string): RawLocationPayload[] | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key: string, data: RawLocationPayload[]): void {
  if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (!oldest.done) memoryCache.delete(oldest.value);
  }
  memoryCache.set(key, { at: Date.now(), data });
}

/** Build the lon/lat lattice, row-major from south to north. */
export function buildGridPoints(grid: GridSpec): { lats: number[]; lngs: number[] } {
  const { cols, rows } = grid;
  const lats: number[] = [];
  const lngs: number[] = [];

  for (let r = 0; r < rows; r += 1) {
    const lat = rows === 1 ? 0 : -85 + (170 * r) / (rows - 1);
    for (let c = 0; c < cols; c += 1) {
      const lng = -180 + (360 * c) / cols;
      lats.push(Math.round(lat * 100) / 100);
      lngs.push(Math.round(lng * 100) / 100);
    }
  }

  return { lats, lngs };
}

/** Variable name builder for a pressure level, e.g. `wind_speed_500hPa`. */
export function levelVar(prefix: string, level: number | 'surface'): string {
  if (level === 'surface') {
    const map: Record<string, string> = {
      wind_speed: 'wind_speed_10m',
      wind_direction: 'wind_direction_10m',
      temperature: 'temperature_2m',
      relative_humidity: 'relative_humidity_2m',
      dew_point: 'dew_point_2m',
      geopotential_height: 'surface_pressure',
      cloud_cover: 'cloud_cover',
      vertical_velocity: 'vertical_velocity_10m',
    };
    return map[prefix] ?? `${prefix}_2m`;
  }
  return `${prefix}_${level}hPa`;
}

/**
 * Variable-name prefix for a scalar field. `wind_speed` reuses the wind variable
 * that is always requested anyway, so it costs nothing extra.
 */
function scalarPrefix(scalarId: ScalarFieldId): string {
  switch (scalarId) {
    case 'wind_speed':
      return 'wind_speed';
    case 'temperature':
      return 'temperature';
    case 'geopotential_height':
      return 'geopotential_height';
    case 'relative_humidity':
      return 'relative_humidity';
    case 'cloud_cover':
      return 'cloud_cover';
    case 'vertical_velocity':
      return 'vertical_velocity';
    default:
      return 'temperature';
  }
}

export interface FetchFieldOptions {
  grid: GridSpec;
  level: number | 'surface';
  scalarId: ScalarFieldId;
  /** UTC epoch ms range for the timeline window. */
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
  /** Open-Meteo model id list; defaults to the seamless multi-model blend. */
  models?: string;
  resolution?: 'hourly' | 'hourly_3';
}

export interface FetchFieldResult {
  payload: RawLocationPayload[];
  times: string[];
  model: string;
  /** Number of upstream coordinate-calls consumed (may be served from cache). */
  billed: number;
  cacheHit: boolean;
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Fetch one level's wind + scalar field for the whole grid.
 *
 * Variables are chosen so a single pass yields everything the particle layer,
 * the heat layer and the probe need: speed, direction, the requested scalar,
 * and geopotential height for the altitude readout.
 */
export async function fetchField(options: FetchFieldOptions): Promise<FetchFieldResult> {
  const {
    grid,
    level,
    scalarId,
    startMs,
    endMs,
    signal,
    models = '',
    resolution = options.resolution ?? 'hourly',
  } = options;

  const prefix = scalarPrefix(scalarId);

  const variables = Array.from(
    new Set([
      levelVar('wind_speed', level),
      levelVar('wind_direction', level),
      levelVar('temperature', level),
      levelVar('geopotential_height', level),
      levelVar(prefix, level),
    ]),
  );

  const { lats, lngs } = buildGridPoints(grid);

  const startDate = isoDate(startMs);
  const endDate = isoDate(endMs);

  const signature = [
    FORECAST_BASE,
    `${grid.cols}x${grid.rows}`,
    String(level),
    scalarId,
    variables.join(','),
    startDate,
    endDate,
    resolution,
    models || 'seamless',
  ].join('|');

  const cached = cacheGet(signature);
  if (cached) {
    const cachedTimes = cached[0]?.hourly?.time;
    return {
      payload: cached,
      times: Array.isArray(cachedTimes) ? (cachedTimes as string[]) : [],
      model: models || 'seamless',
      billed: 0,
      cacheHit: true,
    };
  }

  const needed = lats.length;

  // Guard the minute budget before spending it, so we fail fast and locally
  // rather than burning a 429 from upstream.
  const snapshot = quotaSnapshot();
  if (!hasQuotaFor(needed)) {
    throw new UpstreamQuotaError(
      `本地请求预算不足：本分钟剩余 ${snapshot.remaining} 个坐标点，本次需要 ${needed} 个。请等待 ${Math.ceil(snapshot.resetInMs / 1000)} 秒。`,
    );
  }

  const chunks: Promise<RawLocationPayload[]>[] = [];

  for (let offset = 0; offset < lats.length; offset += POINTS_PER_REQUEST) {
    const latChunk = lats.slice(offset, offset + POINTS_PER_REQUEST);
    const lngChunk = lngs.slice(offset, offset + POINTS_PER_REQUEST);

    const params = new URLSearchParams({
      latitude: latChunk.join(','),
      longitude: lngChunk.join(','),
      hourly: variables.join(','),
      start_date: startDate,
      end_date: endDate,
      timezone: 'UTC',
      wind_speed_unit: 'ms',
      temporal_resolution: resolution,
    });

    // Passing `models` makes Open-Meteo suffix every variable with the model
    // id (wind_speed_500hPa_ecmwf_ifs025). Only ask for explicit models when
    // the caller names them; otherwise the seamless default keeps plain keys.
    if (models) {
      params.set('models', models);
    }

    const url = `${FORECAST_BASE}?${params.toString()}`;

    chunks.push(
      fetch(url, {
        signal,
        headers: { Accept: 'application/json' },
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if (res.status === 429) {
            throw new UpstreamQuotaError(
              'Open-Meteo 返回 429：本分钟请求额度已用尽，请稍候重试。',
            );
          }
          throw new Error(`Open-Meteo ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = (await res.json()) as RawLocationPayload | RawLocationPayload[];
        return Array.isArray(json) ? json : [json];
      }),
    );
  }

  noteUpstreamSpend(needed);

  const settled = await Promise.all(chunks);
  const payload = settled.flat();

  if (payload.length !== needed) {
    throw new Error(
      `Open-Meteo 返回了 ${payload.length} 个坐标点，期望 ${needed} 个。`,
    );
  }

  const rawTimes = payload[0]?.hourly?.time;
  const times = Array.isArray(rawTimes) ? (rawTimes as string[]) : [];
  if (times.length === 0) {
    throw new Error('Open-Meteo 返回的时次为空。');
  }

  cacheSet(signature, payload);

  return { payload, times, model: models || 'seamless', billed: needed, cacheHit: false };
}

export class UpstreamQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamQuotaError';
  }
}

/* ------------------------------------------------------------------ */
/* Secondary layers (Stage 1 only needs the metadata endpoint stubs)   */
/* ------------------------------------------------------------------ */

export interface MarineSample {
  time: string;
  waveHeight: number | null;
  wavePeriod: number | null;
  waveDirection: number | null;
}

/** Marine wave data for a small set of points (L1 group). */
export async function fetchMarine(
  points: { lat: number; lng: number }[],
  signal?: AbortSignal,
): Promise<RawLocationPayload[]> {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    hourly: 'wave_height,wave_period,wave_direction',
    forecast_days: '2',
    timezone: 'UTC',
  });

  const res = await fetch(`${MARINE_BASE}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Marine API ${res.status}`);
  const json = (await res.json()) as RawLocationPayload | RawLocationPayload[];
  return Array.isArray(json) ? json : [json];
}

/** Air-quality data for a small set of points (L2 group). */
export async function fetchAirQuality(
  points: { lat: number; lng: number }[],
  signal?: AbortSignal,
): Promise<RawLocationPayload[]> {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    hourly: 'pm2_5,dust,uv_index,aerosol_optical_depth',
    forecast_days: '2',
    timezone: 'UTC',
  });

  const res = await fetch(`${AIR_QUALITY_BASE}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Air Quality API ${res.status}`);
  const json = (await res.json()) as RawLocationPayload | RawLocationPayload[];
  return Array.isArray(json) ? json : [json];
}

export { FORECAST_BASE, MARINE_BASE, AIR_QUALITY_BASE, ENSEMBLE_BASE };
