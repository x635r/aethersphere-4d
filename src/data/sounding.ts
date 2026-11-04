/**
 * Stage 2 data access: vertical soundings and cross-section transects.
 *
 * Both endpoints are the same Open-Meteo forecast API used by Stage 1, so they
 * share its cost model (one billed call per coordinate) and minute budget. A
 * single sounding is therefore 1 call, and a 20-point transect is 20 calls.
 *
 * Budget hygiene:
 *  - soundings and transects are cached by (lat/lng, hour, variable set),
 *  - the transect sampler spaces its points along a true great circle and
 *    dedupes coordinates that land inside the same grid cell,
 *  - requests go through the shared quota sentinel in `openMeteo.ts`.
 */

import { PRESSURE_LEVELS } from '../core/levels';
import type { SoundingLevel } from '../utils/thermodynamics';
import { standardHeightFromPressure } from '../utils/thermodynamics';
import { noteUpstreamSpend, hasQuotaFor } from './quota';

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';

/** Levels used by the cross-section. The surface-near 975/950 add no value in a
 *  slice view and each level costs encoding space, so 16 levels are used. */
export const SECTION_LEVELS = [
  1000, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100,
] as const;

/** Variables fetched at every level for a transect. */
const SECTION_VARIABLES = [
  'temperature',
  'relative_humidity',
  'cloud_cover',
  'wind_speed',
  'wind_direction',
  'vertical_velocity',
] as const;

/** Variables fetched at every level for a full sounding. */
const SOUNDING_VARIABLES = [
  'temperature',
  'dew_point',
  'relative_humidity',
  'wind_speed',
  'wind_direction',
  'geopotential_height',
  'cloud_cover',
  'vertical_velocity',
] as const;

/** Surface-level parameters required by the Skew-T diagnostics. */
const SURFACE_VARIABLES = [
  'cape',
  'convective_inhibition',
  'lifted_index',
  'freezing_level_height',
  'surface_pressure',
  'temperature_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'relative_humidity_2m',
] as const;

/* ------------------------------------------------------------------ */
/* Caching                                                             */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 48;

interface CacheEntry<T> {
  at: number;
  value: T;
}

const soundingCache = new Map<string, CacheEntry<SoundingProfile>>();
const sectionCache = new Map<string, CacheEntry<CrossSectionData>>();

function cacheKey(parts: (string | number)[]): string {
  return parts.join('|');
}

function readCache<T>(store: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { at: Date.now(), value });
}

/* ------------------------------------------------------------------ */
/* Sounding                                                            */
/* ------------------------------------------------------------------ */

export interface SoundingProfile {
  latitude: number;
  longitude: number;
  /** Model elevation of the grid cell, m. */
  elevation: number;
  /** UTC epoch ms of the retrieved hour. */
  time: number;
  levels: SoundingLevel[];
  surface: {
    pressure: number;
    temperature: number;
    dewPoint: number;
    windSpeed: number;
    windDirection: number;
    relativeHumidity: number;
    /** Upstream CAPE (J/kg); the engine recomputes its own from the profile. */
    cape: number | null;
    cin: number | null;
    liftedIndex: number | null;
    freezingLevel: number | null;
  };
}

export interface FetchSoundingOptions {
  lat: number;
  lng: number;
  /** UTC epoch ms; snapped to the containing hour. */
  timeMs: number;
  signal?: AbortSignal;
}

function isoHour(epochMs: number): string {
  const d = new Date(epochMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13);
}

/**
 * Fetch one full 19-level sounding plus the surface convective parameters.
 *
 * Costs a single Open-Meteo call because only one coordinate is requested.
 */
export async function fetchSounding(options: FetchSoundingOptions): Promise<SoundingProfile> {
  const { lat, lng, timeMs, signal } = options;

  const hour = isoHour(timeMs);
  const key = cacheKey(['sounding', lat.toFixed(3), lng.toFixed(3), hour]);

  const cached = readCache(soundingCache, key);
  if (cached) return cached;

  if (!hasQuotaFor(1)) {
    throw new Error('Open-Meteo 本分钟额度不足，无法获取探空廓线。');
  }

  const hourly = [
    ...PRESSURE_LEVELS.flatMap((p) =>
      SOUNDING_VARIABLES.map((v) => `${v}_${p}hPa`),
    ),
    ...SURFACE_VARIABLES,
  ];

  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    hourly: hourly.join(','),
    start_date: hour.slice(0, 10),
    end_date: hour.slice(0, 10),
    timezone: 'UTC',
    wind_speed_unit: 'ms',
  });

  const response = await fetch(`${FORECAST_BASE}?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Open-Meteo 返回 429：请求额度已用尽，请稍候再试。');
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Open-Meteo ${response.status}: ${body.slice(0, 160)}`);
  }

  noteUpstreamSpend(1);

  const json = (await response.json()) as {
    latitude: number;
    longitude: number;
    elevation?: number;
    hourly: Record<string, (number | null)[] | string[]>;
  };

  const times = json.hourly?.time;
  if (!Array.isArray(times)) {
    throw new Error('探空响应缺少 time 序列。');
  }

  // Snap the requested instant onto the returned hourly slot.
  const targetIso = hour;
  let index = (times as string[]).findIndex((t) => t.startsWith(targetIso));
  if (index < 0) index = 0;

  const num = (name: string): number => {
    const series = json.hourly?.[name];
    if (!Array.isArray(series)) return Number.NaN;
    const v = series[index];
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  };

  const levels: SoundingLevel[] = [];

  for (const pressure of PRESSURE_LEVELS) {
    const temperature = num(`temperature_${pressure}hPa`);
    const dewPoint = num(`dew_point_${pressure}hPa`);
    const heightRaw = num(`geopotential_height_${pressure}hPa`);

    // A level entirely underground has no data at all; skip rather than
    // injecting a fabricated 0 °C point into the profile.
    if (!Number.isFinite(temperature)) continue;

    levels.push({
      pressure,
      temperature,
      dewPoint: Number.isFinite(dewPoint) ? dewPoint : temperature - 12,
      height: Number.isFinite(heightRaw) ? heightRaw : standardHeightFromPressure(pressure),
      windSpeed: Number.isFinite(num(`wind_speed_${pressure}hPa`)) ? num(`wind_speed_${pressure}hPa`) : 0,
      windDirection: Number.isFinite(num(`wind_direction_${pressure}hPa`)) ? num(`wind_direction_${pressure}hPa`) : 0,
      relativeHumidity: num(`relative_humidity_${pressure}hPa`),
      cloudCover: num(`cloud_cover_${pressure}hPa`),
      verticalVelocity: num(`vertical_velocity_${pressure}hPa`),
    });
  }

  if (levels.length < 3) {
    throw new Error('该位置返回的等压面层数不足，无法绘制斜温图。');
  }

  // Attach the true surface as the lowest level, so the parcel starts from the
  // ground rather than from 1000 hPa (which may be underground).
  const surfacePressure = num('surface_pressure');
  const surfaceTemp = num('temperature_2m');
  const surfaceDew = num('dew_point_2m');

  if (Number.isFinite(surfacePressure) && Number.isFinite(surfaceTemp)) {
    const groundLevel: SoundingLevel = {
      pressure: surfacePressure,
      temperature: surfaceTemp,
      dewPoint: Number.isFinite(surfaceDew) ? surfaceDew : surfaceTemp - 10,
      height: json.elevation ?? 0,
      windSpeed: Number.isFinite(num('wind_speed_10m')) ? num('wind_speed_10m') : 0,
      windDirection: Number.isFinite(num('wind_direction_10m')) ? num('wind_direction_10m') : 0,
      relativeHumidity: num('relative_humidity_2m'),
    };

    // Replace rather than duplicate when the surface coincides with a level.
    const existing = levels.findIndex((l) => Math.abs(l.pressure - surfacePressure) < 1);
    if (existing >= 0) levels[existing] = groundLevel;
    else levels.unshift(groundLevel);
  }

  levels.sort((a, b) => b.pressure - a.pressure);

  const profile: SoundingProfile = {
    latitude: json.latitude,
    longitude: json.longitude,
    elevation: json.elevation ?? 0,
    time: Date.parse(`${times[index]}Z`),
    levels,
    surface: {
      pressure: surfacePressure,
      temperature: surfaceTemp,
      dewPoint: surfaceDew,
      windSpeed: num('wind_speed_10m'),
      windDirection: num('wind_direction_10m'),
      relativeHumidity: num('relative_humidity_2m'),
      cape: Number.isFinite(num('cape')) ? num('cape') : null,
      cin: Number.isFinite(num('convective_inhibition')) ? num('convective_inhibition') : null,
      liftedIndex: Number.isFinite(num('lifted_index')) ? num('lifted_index') : null,
      freezingLevel: Number.isFinite(num('freezing_level_height')) ? num('freezing_level_height') : null,
    },
  };

  writeCache(soundingCache, key, profile);
  return profile;
}

/* ------------------------------------------------------------------ */
/* Great-circle transect                                               */
/* ------------------------------------------------------------------ */

/** A single node of the user-drawn polyline. */
export interface LngLatPoint {
  lng: number;
  lat: number;
}

export interface SectionSample {
  lng: number;
  lat: number;
  /** Cumulative distance from the first node, km. */
  distanceKm: number;
  /** Per-level values at this point; arrays align with `CrossSectionData.levels`. */
  temperature: number[];
  relativeHumidity: number[];
  cloudCover: number[];
  windSpeed: number[];
  windDirection: number[];
  verticalVelocity: number[];
  /** Horizontal wind projected onto the section tangent, m/s (u along-section). */
  tangentWind: number[];
}

export interface CrossSectionData {
  levels: number[];
  samples: SectionSample[];
  /** Total polyline length, km. */
  lengthKm: number;
  time: number;
  /** Node coordinates the transect was built from. */
  nodes: LngLatPoint[];
}

/** Great-circle interpolation between two points (slerp on the unit sphere). */
export function greatCircleInterpolate(
  a: LngLatPoint,
  b: LngLatPoint,
  t: number,
): LngLatPoint {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const lat1 = a.lat * toRad;
  const lng1 = a.lng * toRad;
  const lat2 = b.lat * toRad;
  const lng2 = b.lng * toRad;

  const x1 = Math.cos(lat1) * Math.cos(lng1);
  const y1 = Math.cos(lat1) * Math.sin(lng1);
  const z1 = Math.sin(lat1);

  const x2 = Math.cos(lat2) * Math.cos(lng2);
  const y2 = Math.cos(lat2) * Math.sin(lng2);
  const z2 = Math.sin(lat2);

  const dot = Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  let k1: number;
  let k2: number;

  if (sinOmega < 1e-9) {
    // Coincident (or antipodal) endpoints: fall back to linear blending.
    k1 = 1 - t;
    k2 = t;
  } else {
    k1 = Math.sin((1 - t) * omega) / sinOmega;
    k2 = Math.sin(t * omega) / sinOmega;
  }

  const x = k1 * x1 + k2 * x2;
  const y = k1 * y1 + k2 * y2;
  const z = k1 * z1 + k2 * z2;

  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * toDeg;
  const lng = Math.atan2(y, x) * toDeg;

  return { lat, lng };
}

/** Great-circle distance in km (haversine). */
export function greatCircleDistanceKm(a: LngLatPoint, b: LngLatPoint): number {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Sample the polyline into `count` evenly spaced great-circle points.
 * Distance is measured along each leg so a multi-node path keeps uniform spacing
 * instead of over-sampling the shorter segments.
 */
export function samplePolyline(nodes: LngLatPoint[], count: number): SectionSample[] {
  if (nodes.length < 2) return [];

  // Precompute per-leg great-circle length.
  const legs: { a: LngLatPoint; b: LngLatPoint; km: number }[] = [];
  let total = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    const km = greatCircleDistanceKm(nodes[i - 1], nodes[i]);
    legs.push({ a: nodes[i - 1], b: nodes[i], km });
    total += km;
  }

  const samples: SectionSample[] = [];
  const steps = Math.max(2, count);

  for (let s = 0; s < steps; s += 1) {
    const target = (s / (steps - 1)) * total;

    let acc = 0;
    let point: LngLatPoint = nodes[0];

    for (const leg of legs) {
      if (target <= acc + leg.km || leg === legs[legs.length - 1]) {
        const local = leg.km > 0 ? Math.min(1, (target - acc) / leg.km) : 0;
        point = greatCircleInterpolate(leg.a, leg.b, local);
        break;
      }
      acc += leg.km;
    }

    samples.push({
      lng: point.lng,
      lat: point.lat,
      distanceKm: target,
      temperature: [],
      relativeHumidity: [],
      cloudCover: [],
      windSpeed: [],
      windDirection: [],
      verticalVelocity: [],
      tangentWind: [],
    });
  }

  return samples;
}

/** Bearing from A to B in degrees clockwise from north. */
export function bearingDegrees(a: LngLatPoint, b: LngLatPoint): number {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLng = (b.lng - a.lng) * toRad;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return ((Math.atan2(y, x) * toDeg) + 360) % 360;
}

export interface FetchCrossSectionOptions {
  nodes: LngLatPoint[];
  timeMs: number;
  /** Number of along-track samples, default 20. */
  sampleCount?: number;
  signal?: AbortSignal;
}

/**
 * Fetch the transect: one batched request covering all along-track points.
 *
 * A 20-point transect is a single HTTP request but still bills 20 coordinate
 * calls, which is why the result is cached aggressively.
 */
export async function fetchCrossSection(
  options: FetchCrossSectionOptions,
): Promise<CrossSectionData> {
  const { nodes, timeMs, signal } = options;
  const sampleCount = options.sampleCount ?? 20;

  if (nodes.length < 2) {
    throw new Error('剖面至少需要两个节点。');
  }

  const samples = samplePolyline(nodes, sampleCount);
  const hour = isoHour(timeMs);
  const key = cacheKey([
    'section',
    hour,
    nodes.map((n) => `${n.lat.toFixed(2)},${n.lng.toFixed(2)}`).join(';'),
    sampleCount,
  ]);

  const cached = readCache(sectionCache, key);
  if (cached) return cached;

  if (!hasQuotaFor(samples.length)) {
    throw new Error(
      `Open-Meteo 本分钟额度不足：剖面需要 ${samples.length} 个坐标点。`,
    );
  }

  const levels = [...SECTION_LEVELS];
  const hourly = levels.flatMap((p) =>
    SECTION_VARIABLES.map((v) => `${v}_${p}hPa`),
  );

  const params = new URLSearchParams({
    latitude: samples.map((s) => s.lat.toFixed(3)).join(','),
    longitude: samples.map((s) => s.lng.toFixed(3)).join(','),
    hourly: hourly.join(','),
    start_date: hour.slice(0, 10),
    end_date: hour.slice(0, 10),
    timezone: 'UTC',
    wind_speed_unit: 'ms',
  });

  const response = await fetch(`${FORECAST_BASE}?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Open-Meteo 返回 429：请求额度已用尽，请稍候再试。');
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Open-Meteo ${response.status}: ${body.slice(0, 160)}`);
  }

  noteUpstreamSpend(samples.length);

  const json = (await response.json()) as
    | { hourly: Record<string, (number | null)[] | string[]> }[]
    | { hourly: Record<string, (number | null)[] | string[]> };

  const locations = Array.isArray(json) ? json : [json];
  if (locations.length !== samples.length) {
    throw new Error(
      `剖面返回 ${locations.length} 个坐标点，期望 ${samples.length} 个。`,
    );
  }

  const times = locations[0]?.hourly?.time;
  const timeStrings = Array.isArray(times) ? (times as string[]) : [];
  let timeIndex = timeStrings.findIndex((t) => t.startsWith(hour));
  if (timeIndex < 0) timeIndex = 0;

  // Compute the along-track tangent at each sample so the cross-section can
  // show the wind component actually flowing across the slice.
  const tangents = samples.map((_, i) => {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    return bearingDegrees(a, b);
  });

  for (let i = 0; i < samples.length; i += 1) {
    const hourlyBlock = locations[i]?.hourly ?? {};
    const sample = samples[i];

    const num = (name: string): number => {
      const series = hourlyBlock[name];
      if (!Array.isArray(series)) return Number.NaN;
      const v = series[timeIndex];
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    };

    const tangent = tangents[i];
    const toRad = Math.PI / 180;

    for (const p of levels) {
      sample.temperature.push(num(`temperature_${p}hPa`));
      sample.relativeHumidity.push(num(`relative_humidity_${p}hPa`));
      sample.cloudCover.push(num(`cloud_cover_${p}hPa`));

      const speed = num(`wind_speed_${p}hPa`);
      const dir = num(`wind_direction_${p}hPa`);
      sample.windSpeed.push(speed);
      sample.windDirection.push(dir);
      sample.verticalVelocity.push(num(`vertical_velocity_${p}hPa`));

      // Project the wind onto the section normal (the component crossing the
      // slice). Meteorological direction is where the wind comes FROM.
      if (Number.isFinite(speed) && Number.isFinite(dir)) {
        const wu = -speed * Math.sin(dir * toRad);
        const wv = -speed * Math.cos(dir * toRad);
        const tu = Math.sin(tangent * toRad);
        const tv = Math.cos(tangent * toRad);
        // Positive = blowing along the section from start to end.
        sample.tangentWind.push(wu * tu + wv * tv);
      } else {
        sample.tangentWind.push(Number.NaN);
      }
    }
  }

  const data: CrossSectionData = {
    levels,
    samples,
    lengthKm: samples[samples.length - 1]?.distanceKm ?? 0,
    time: timeStrings[timeIndex] ? Date.parse(`${timeStrings[timeIndex]}Z`) : timeMs,
    nodes,
  };

  writeCache(sectionCache, key, data);
  return data;
}

/** Expose cache controls for the UI's manual refresh. */
export function clearSoundingCaches(): void {
  soundingCache.clear();
  sectionCache.clear();
}
