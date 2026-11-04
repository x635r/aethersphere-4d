/**
 * Stage 3 data access: multi-model comparison, the 5880 gpm spaghetti field,
 * atmospheric-river IVT grids, RainViewer radar, and CAMS air quality.
 *
 * Cost model reminder: Open-Meteo bills one call per coordinate, so every
 * fetcher here is aggressive about caching and about requesting the smallest
 * grid that still reads well. Rainbow/satellite endpoints (RainViewer, CAMS) are
 * free and unmetered.
 */

import type { GridSpec } from '../core/types';
import { buildGridPoints } from './openMeteo';
import { hasQuotaFor, noteUpstreamSpend } from './quota';
import { IVT_LEVELS, buildMoistureColumn, computeIvt, type IvtResult } from '../utils/ivt';

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/* ------------------------------------------------------------------ */
/* Generic cache                                                       */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 8 * 60 * 1000;
const CACHE_MAX = 40;

interface Entry<T> {
  at: number;
  value: T;
}

function makeCache<T>(max = CACHE_MAX) {
  const store = new Map<string, Entry<T>>();
  return {
    get(key: string): T | null {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > CACHE_TTL_MS) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key: string, value: T): void {
      if (store.size >= max) {
        const oldest = store.keys().next();
        if (!oldest.done) store.delete(oldest.value);
      }
      store.set(key, { at: Date.now(), value });
    },
    clear(): void {
      store.clear();
    },
  };
}

function isoHour(epochMs: number): string {
  const d = new Date(epochMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13);
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error('Open-Meteo 返回 429：请求额度已用尽，请稍候再试。');
    }
    const body = await res.text().catch(() => '');
    throw new Error(`请求失败 ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Multi-model comparison                                              */
/* ------------------------------------------------------------------ */

/** The four models the arena compares, in display order. */
export const ARENA_MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS', short: 'IFS', color: '#e879f9', note: '欧洲中心 9km 物理模式' },
  { id: 'ecmwf_aifs025', label: 'ECMWF AIFS', short: 'AIFS', color: '#22d3ee', note: '欧洲中心 AI 大模型' },
  { id: 'gfs_seamless', label: 'NOAA GFS', short: 'GFS', color: '#fbbf24', note: '美国全球模式' },
  { id: 'icon_seamless', label: 'DWD ICON', short: 'ICON', color: '#34d399', note: '德国气象局模式' },
] as const;

export type ArenaModelId = (typeof ARENA_MODELS)[number]['id'];

/** Variables compared across models. */
export const ARENA_VARIABLES = [
  { id: 'temperature_2m', label: '2m 温度', unit: '°C', decimals: 1 },
  { id: 'precipitation', label: '降水量', unit: 'mm', decimals: 1 },
  { id: 'surface_pressure', label: '海平面气压', unit: 'hPa', decimals: 1 },
  { id: 'wind_gusts_10m', label: '阵风', unit: 'm/s', decimals: 1 },
] as const;

export type ArenaVariableId = (typeof ARENA_VARIABLES)[number]['id'];

export interface ArenaSeries {
  model: ArenaModelId;
  /** One value per timestamp; NaN where the model produced nothing. */
  values: number[];
}

export interface ArenaSpreadPoint {
  time: number;
  /** Mean across models. */
  mean: number;
  /** Standard deviation across models. */
  spread: number;
  /** Per-model values at this time. */
  values: Record<ArenaModelId, number>;
}

export interface ArenaResult {
  latitude: number;
  longitude: number;
  variable: ArenaVariableId;
  unit: string;
  times: number[];
  series: ArenaSeries[];
  spread: ArenaSpreadPoint[];
  /** Windows where the inter-model spread exceeds the chaos threshold. */
  chaosWindows: { startIndex: number; endIndex: number; peakSpread: number }[];
  /** Largest spread in the series, for normalising the chart. */
  maxSpread: number;
}

const arenaCache = makeCache<ArenaResult>();

/**
 * Fetch a single-point, four-model comparison.
 *
 * One field per model comes back suffixed with `_<model id>`; this function
 * strips the suffix so callers never have to know that Open-Meteo rewrites the
 * variable names when `models=` is present (a trap that silently produced an
 * all-NaN field in earlier work).
 */
export async function fetchModelArena(options: {
  lat: number;
  lng: number;
  variable: ArenaVariableId;
  timeMs: number;
  days?: number;
  signal?: AbortSignal;
}): Promise<ArenaResult> {
  const { lat, lng, variable, timeMs, signal } = options;
  const days = options.days ?? 10;

  const key = `arena|${lat.toFixed(2)}|${lng.toFixed(2)}|${variable}|${isoDate(timeMs)}|${days}`;
  const cached = arenaCache.get(key);
  if (cached) return cached;

  // One coordinate, four models -> 4 billed calls.
  const calls = ARENA_MODELS.length;
  if (!hasQuotaFor(calls)) {
    throw new Error(`额度不足：多模型对比需要 ${calls} 个坐标调用。`);
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    hourly: variable,
    models: ARENA_MODELS.map((m) => m.id).join(','),
    forecast_days: String(days),
    timezone: 'UTC',
    wind_speed_unit: 'ms',
  });

  const json = await getJson<{
    latitude: number;
    longitude: number;
    hourly: Record<string, (number | null)[] | string[]>;
  }>(`${FORECAST_BASE}?${params.toString()}`, signal);

  noteUpstreamSpend(calls);

  const hourly = json.hourly ?? {};
  const rawTimes = hourly.time;
  const timeStrings = Array.isArray(rawTimes) ? (rawTimes as string[]) : [];
  if (timeStrings.length === 0) {
    throw new Error('多模型对比返回的时次为空。');
  }

  const times = timeStrings.map((t) => Date.parse(`${t}Z`));

  const series: ArenaSeries[] = ARENA_MODELS.map((model) => {
    const seriesKey = `${variable}_${model.id}`;
    const raw = hourly[seriesKey];
    const arr = Array.isArray(raw) ? raw : [];

    return {
      model: model.id,
      values: timeStrings.map((_, i) => {
        const v = arr[i];
        return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
      }),
    };
  });

  // Inter-model spread per timestep.
  const spread: ArenaSpreadPoint[] = timeStrings.map((_, i) => {
    const vals: Record<string, number> = {};
    const finite: number[] = [];

    for (const s of series) {
      const v = s.values[i];
      vals[s.model] = v;
      if (Number.isFinite(v)) finite.push(v);
    }

    if (finite.length === 0) {
      return {
        time: times[i],
        mean: Number.NaN,
        spread: Number.NaN,
        values: vals as Record<ArenaModelId, number>,
      };
    }

    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    // Sample standard deviation; with fewer than two models it is zero.
    const variance =
      finite.length > 1
        ? finite.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (finite.length - 1)
        : 0;

    return {
      time: times[i],
      mean,
      spread: Math.sqrt(variance),
      values: vals as Record<ArenaModelId, number>,
    };
  });

  const maxSpread = Math.max(
    0,
    ...spread.map((s) => (Number.isFinite(s.spread) ? s.spread : 0)),
  );

  // Chaos windows: contiguous runs where spread exceeds 60% of the peak.
  // That is where the models genuinely disagree about the evolution, i.e. the
  // forecast is not yet trustworthy.
  const chaosThreshold = maxSpread * 0.6;
  const chaosWindows: { startIndex: number; endIndex: number; peakSpread: number }[] = [];

  if (maxSpread > 0) {
    let runStart = -1;
    let peak = 0;

    for (let i = 0; i <= spread.length; i += 1) {
      const inRun = i < spread.length && spread[i].spread >= chaosThreshold;
      if (inRun) {
        if (runStart < 0) {
          runStart = i;
          peak = 0;
        }
        peak = Math.max(peak, spread[i].spread);
      } else if (runStart >= 0) {
        // Only report windows worth highlighting.
        if (i - runStart >= 3) {
          chaosWindows.push({ startIndex: runStart, endIndex: i - 1, peakSpread: peak });
        }
        runStart = -1;
      }
    }
  }

  const result: ArenaResult = {
    latitude: json.latitude,
    longitude: json.longitude,
    variable,
    unit: ARENA_VARIABLES.find((v) => v.id === variable)?.unit ?? '',
    times,
    series,
    spread,
    chaosWindows,
    maxSpread,
  };

  arenaCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* 5880 gpm spaghetti                                                  */
/* ------------------------------------------------------------------ */

export interface SpaghettiModel {
  model: ArenaModelId;
  label: string;
  color: string;
  /** Row-major grid of 500 hPa geopotential height, gpm. */
  values: Float32Array;
  /** True where the model has no data for the cell. */
  min: number;
  max: number;
}

export interface SpaghettiResult {
  grid: GridSpec;
  models: SpaghettiModel[];
  time: number;
  /** Level of the ridge line, gpm. */
  contourLevel: number;
}

const spaghettiCache = makeCache<SpaghettiResult>();

/**
 * Fetch 500 hPa geopotential height for all four models on a coarse globe grid.
 *
 * Uses the same 24x12 lattice as Stage 1 (288 points, 4 models) but at a single
 * time step, so it costs 288 calls rather than 288 per model.
 */
export async function fetchSpaghetti(options: {
  grid: GridSpec;
  timeMs: number;
  contourLevel?: number;
  signal?: AbortSignal;
}): Promise<SpaghettiResult> {
  const { grid, timeMs, signal } = options;
  const contourLevel = options.contourLevel ?? 5880;

  const key = `spaghetti|${grid.cols}x${grid.rows}|${isoHour(timeMs)}|${contourLevel}`;
  const cached = spaghettiCache.get(key);
  if (cached) return cached;

  const { lats, lngs } = buildGridPoints(grid);
  const needed = lats.length;

  if (!hasQuotaFor(needed)) {
    throw new Error(`额度不足：5880 面条图需要 ${needed} 个坐标调用。`);
  }

  const params = new URLSearchParams({
    latitude: lats.join(','),
    longitude: lngs.join(','),
    hourly: 'geopotential_height_500hPa',
    models: ARENA_MODELS.map((m) => m.id).join(','),
    start_date: isoDate(timeMs),
    end_date: isoDate(timeMs),
    timezone: 'UTC',
  });

  const json = await getJson<
    { hourly: Record<string, (number | null)[] | string[]> }[]
  >(`${FORECAST_BASE}?${params.toString()}`, signal);

  noteUpstreamSpend(needed);

  const locations = Array.isArray(json) ? json : [json];
  if (locations.length !== needed) {
    throw new Error(`面条图返回 ${locations.length} 个点，期望 ${needed} 个。`);
  }

  const times = locations[0]?.hourly?.time;
  const timeStrings = Array.isArray(times) ? (times as string[]) : [];
  const targetHour = isoHour(timeMs);
  let idx = timeStrings.findIndex((t) => t.startsWith(targetHour));
  if (idx < 0) idx = 0;

  const models: SpaghettiModel[] = ARENA_MODELS.map((model) => {
    const values = new Float32Array(needed);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    const seriesKey = `geopotential_height_500hPa_${model.id}`;

    for (let i = 0; i < needed; i += 1) {
      const series = locations[i]?.hourly?.[seriesKey];
      const v = Array.isArray(series) ? series[idx] : null;
      const num = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
      values[i] = num;
      if (Number.isFinite(num)) {
        if (num < min) min = num;
        if (num > max) max = num;
      }
    }

    return {
      model: model.id,
      label: model.short,
      color: model.color,
      values,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
    };
  });

  const result: SpaghettiResult = {
    grid,
    models,
    time: timeStrings[idx] ? Date.parse(`${timeStrings[idx]}Z`) : timeMs,
    contourLevel,
  };

  spaghettiCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Atmospheric river / IVT grid                                        */
/* ------------------------------------------------------------------ */

export interface IvtField {
  grid: GridSpec;
  /** IVT magnitude per cell, kg·m⁻¹·s⁻¹. */
  values: Float32Array;
  /** Per-cell category, 0 = not an AR. */
  categories: Uint8Array;
  time: number;
  min: number;
  max: number;
  /** Number of cells that qualify as an AR at any category. */
  arCells: number;
  /** Highest category present. */
  peakCategory: number;
}

const ivtCache = makeCache<IvtField>();

/**
 * Fetch the variables needed for an IVT field and integrate in-process.
 *
 * Each grid cell needs 8 levels x 4 variables, so this is the heaviest fetcher
 * in the app: 288 points x 8 levels = 288 billed calls (the level count lives
 * inside each call, not on top of it). The grid is therefore kept coarse and
 * the result cached for the whole hour.
 */
export async function fetchIvtField(options: {
  grid: GridSpec;
  timeMs: number;
  signal?: AbortSignal;
}): Promise<IvtField> {
  const { grid, timeMs, signal } = options;

  const key = `ivt|${grid.cols}x${grid.rows}|${isoHour(timeMs)}`;
  const cached = ivtCache.get(key);
  if (cached) return cached;

  const { lats, lngs } = buildGridPoints(grid);
  const needed = lats.length;

  if (!hasQuotaFor(needed)) {
    throw new Error(`额度不足：水汽输送场需要 ${needed} 个坐标调用。`);
  }

  const hourly = IVT_LEVELS.flatMap((p) => [
    `dew_point_${p}hPa`,
    `wind_speed_${p}hPa`,
    `wind_direction_${p}hPa`,
  ]);

  const params = new URLSearchParams({
    latitude: lats.join(','),
    longitude: lngs.join(','),
    hourly: hourly.join(','),
    start_date: isoDate(timeMs),
    end_date: isoDate(timeMs),
    timezone: 'UTC',
    wind_speed_unit: 'ms',
  });

  const json = await getJson<
    { hourly: Record<string, (number | null)[] | string[]> }[]
  >(`${FORECAST_BASE}?${params.toString()}`, signal);

  noteUpstreamSpend(needed);

  const locations = Array.isArray(json) ? json : [json];
  if (locations.length !== needed) {
    throw new Error(`水汽场返回 ${locations.length} 个点，期望 ${needed} 个。`);
  }

  const times = locations[0]?.hourly?.time;
  const timeStrings = Array.isArray(times) ? (times as string[]) : [];
  const targetHour = isoHour(timeMs);
  let idx = timeStrings.findIndex((t) => t.startsWith(targetHour));
  if (idx < 0) idx = 0;

  const total = grid.cols * grid.rows;
  const values = new Float32Array(total);
  const categories = new Uint8Array(total);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let arCells = 0;
  let peakCategory = 0;

  for (let i = 0; i < total; i += 1) {
    const block = locations[i]?.hourly ?? {};

    const read = (name: string): number => {
      const series = block[name];
      if (!Array.isArray(series)) return Number.NaN;
      const v = series[idx];
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    };

    const column = buildMoistureColumn({
      levels: IVT_LEVELS,
      // Temperature is not part of the IVT integral; only the dew point matters
      // for specific humidity, so it is supplied as a duplicate to satisfy the
      // shared column builder without an extra upstream variable.
      temperature: (p) => read(`dew_point_${p}hPa`),
      dewPoint: (p) => read(`dew_point_${p}hPa`),
      windSpeed: (p) => read(`wind_speed_${p}hPa`),
      windDirection: (p) => read(`wind_direction_${p}hPa`),
    });

    const result: IvtResult = computeIvt(column);

    if (Number.isFinite(result.ivt)) {
      values[i] = result.ivt;
      categories[i] = result.category;
      if (result.ivt < min) min = result.ivt;
      if (result.ivt > max) max = result.ivt;
      if (result.category > 0) arCells += 1;
      if (result.category > peakCategory) peakCategory = result.category;
    } else {
      values[i] = Number.NaN;
    }
  }

  const field: IvtField = {
    grid,
    values,
    categories,
    time: timeStrings[idx] ? Date.parse(`${timeStrings[idx]}Z`) : timeMs,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    arCells,
    peakCategory,
  };

  ivtCache.set(key, field);
  return field;
}

/* ------------------------------------------------------------------ */
/* RainViewer radar                                                    */
/* ------------------------------------------------------------------ */

export interface RadarFrame {
  time: number;
  path: string;
}

export interface RadarMetadata {
  host: string;
  past: RadarFrame[];
  nowcast: RadarFrame[];
  /** Source actually used, so the UI can surface a failover. */
  source: 'rainviewer' | 'librewxr';
}

const RADAR_PRIMARY = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_MIRROR = 'https://api.librewxr.net/public/weather-maps.json';

let radarCache: { at: number; value: RadarMetadata } | null = null;
const RADAR_TTL_MS = 4 * 60 * 1000;

/**
 * Fetch RainViewer frame metadata, failing over to the LibreWXR mirror.
 *
 * The mirror is a compatibility reimplementation, so its payload is normalised
 * into the same shape here rather than being special-cased downstream.
 */
export async function fetchRadarMetadata(signal?: AbortSignal): Promise<RadarMetadata> {
  if (radarCache && Date.now() - radarCache.at < RADAR_TTL_MS) {
    return radarCache.value;
  }

  const attempt = async (url: string, source: RadarMetadata['source']): Promise<RadarMetadata> => {
    const json = await getJson<{
      host?: string;
      radar?: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] };
    }>(url, signal);

    const host = json.host ?? 'https://tilecache.rainviewer.com';
    const past = (json.radar?.past ?? []).map((f) => ({ time: f.time * 1000, path: f.path }));
    const nowcast = (json.radar?.nowcast ?? []).map((f) => ({ time: f.time * 1000, path: f.path }));

    if (past.length === 0) {
      throw new Error('雷达元数据没有历史帧。');
    }

    return { host, past, nowcast, source };
  };

  let metadata: RadarMetadata;
  try {
    metadata = await attempt(RADAR_PRIMARY, 'rainviewer');
  } catch (primaryError) {
    if (signal?.aborted) throw primaryError;
    metadata = await attempt(RADAR_MIRROR, 'librewxr');
  }

  radarCache = { at: Date.now(), value: metadata };
  return metadata;
}

/**
 * Build a tile URL for one radar frame.
 *
 * `maxzoom` matters: RainViewer serves native tiles only up to z7. Beyond that
 * it answers 200 with a differently-encoded placeholder (RGB, no alpha, and
 * 512px for z>=10) rather than a 404 — so a missing `maxzoom` produces a blank
 * or grey map that looks like a rendering bug instead of a request error.
 * Verified: z6/z7 return 256x256 RGBA tiles with real echoes; z8/z10 return
 * RGB payloads that are error images.
 */
export const RADAR_MAX_NATIVE_ZOOM = 7;

export function radarTileUrl(
  metadata: RadarMetadata,
  frame: RadarFrame,
  z: number,
  x: number,
  y: number,
): string {
  const clampedZ = Math.min(z, RADAR_MAX_NATIVE_ZOOM);
  // Scheme 2 + smooth=1 + snow=0 matches RainViewer's documented tile path.
  return `${metadata.host}${frame.path}/256/${clampedZ}/${x}/${y}/2/1_0.png`;
}

/* ------------------------------------------------------------------ */
/* CAMS air quality                                                    */
/* ------------------------------------------------------------------ */

export const CHEM_VARIABLES = [
  { id: 'pm2_5', label: 'PM2.5', unit: 'μg/m³', palette: 'pm25' },
  { id: 'dust', label: '沙尘', unit: 'μg/m³', palette: 'dust' },
  { id: 'aerosol_optical_depth', label: '气溶胶光学厚度', unit: '', palette: 'aod' },
  { id: 'uv_index', label: 'UV 指数', unit: '', palette: 'uv' },
] as const;

export type ChemVariableId = (typeof CHEM_VARIABLES)[number]['id'];

export interface ChemField {
  variable: ChemVariableId;
  grid: GridSpec;
  values: Float32Array;
  time: number;
  min: number;
  max: number;
}

const chemCache = makeCache<ChemField>();

/** Fetch one CAMS variable on a globe grid. Unmetered, so a finer grid is affordable. */
export async function fetchChemField(options: {
  grid: GridSpec;
  variable: ChemVariableId;
  timeMs: number;
  signal?: AbortSignal;
}): Promise<ChemField> {
  const { grid, variable, timeMs, signal } = options;

  const key = `chem|${variable}|${grid.cols}x${grid.rows}|${isoHour(timeMs)}`;
  const cached = chemCache.get(key);
  if (cached) return cached;

  const { lats, lngs } = buildGridPoints(grid);

  const params = new URLSearchParams({
    latitude: lats.join(','),
    longitude: lngs.join(','),
    hourly: variable,
    start_date: isoDate(timeMs),
    end_date: isoDate(timeMs),
    timezone: 'UTC',
  });

  const json = await getJson<
    { hourly: Record<string, (number | null)[] | string[]> }[]
  >(`${AIR_QUALITY_BASE}?${params.toString()}`, signal);

  const locations = Array.isArray(json) ? json : [json];
  const times = locations[0]?.hourly?.time;
  const timeStrings = Array.isArray(times) ? (times as string[]) : [];
  const targetHour = isoHour(timeMs);
  let idx = timeStrings.findIndex((t) => t.startsWith(targetHour));
  if (idx < 0) idx = 0;

  const total = grid.cols * grid.rows;
  const values = new Float32Array(total);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < total; i += 1) {
    const series = locations[i]?.hourly?.[variable];
    const v = Array.isArray(series) ? series[idx] : null;
    const num = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    values[i] = num;
    if (Number.isFinite(num)) {
      if (num < min) min = num;
      if (num > max) max = num;
    }
  }

  const field: ChemField = {
    variable,
    grid,
    values,
    time: timeStrings[idx] ? Date.parse(`${timeStrings[idx]}Z`) : timeMs,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  };

  chemCache.set(key, field);
  return field;
}

/** Single-point CAMS readout for the diagnostic panel. */
export interface ChemPoint {
  pm25: number;
  dust: number;
  aod: number;
  uv: number;
  europeanAqi: number;
}

const chemPointCache = makeCache<ChemPoint>();

export async function fetchChemPoint(options: {
  lat: number;
  lng: number;
  timeMs: number;
  signal?: AbortSignal;
}): Promise<ChemPoint> {
  const { lat, lng, timeMs, signal } = options;
  const key = `chempoint|${lat.toFixed(2)}|${lng.toFixed(2)}|${isoHour(timeMs)}`;
  const cached = chemPointCache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    hourly: 'pm2_5,dust,aerosol_optical_depth,uv_index,european_aqi',
    start_date: isoDate(timeMs),
    end_date: isoDate(timeMs),
    timezone: 'UTC',
  });

  const json = await getJson<{ hourly: Record<string, (number | null)[] | string[]> }>(
    `${AIR_QUALITY_BASE}?${params.toString()}`,
    signal,
  );

  const times = json.hourly?.time;
  const timeStrings = Array.isArray(times) ? (times as string[]) : [];
  const targetHour = isoHour(timeMs);
  let idx = timeStrings.findIndex((t) => t.startsWith(targetHour));
  if (idx < 0) idx = 0;

  const num = (name: string): number => {
    const series = json.hourly?.[name];
    if (!Array.isArray(series)) return Number.NaN;
    const v = series[idx];
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  };

  const point: ChemPoint = {
    pm25: num('pm2_5'),
    dust: num('dust'),
    aod: num('aerosol_optical_depth'),
    uv: num('uv_index'),
    europeanAqi: num('european_aqi'),
  };

  chemPointCache.set(key, point);
  return point;
}

/** European AQI band, for colouring the badge. */
export function aqiBand(aqi: number): { label: string; color: string } {
  if (!Number.isFinite(aqi)) return { label: '—', color: '#64748b' };
  if (aqi <= 20) return { label: '优', color: '#34d399' };
  if (aqi <= 40) return { label: '良', color: '#a3e635' };
  if (aqi <= 60) return { label: '中等', color: '#fbbf24' };
  if (aqi <= 80) return { label: '较差', color: '#fb923c' };
  if (aqi <= 100) return { label: '差', color: '#f87171' };
  return { label: '极差', color: '#a855f7' };
}

export function clearStage3Caches(): void {
  arenaCache.clear();
  spaghettiCache.clear();
  ivtCache.clear();
  chemCache.clear();
  chemPointCache.clear();
  radarCache = null;
}
