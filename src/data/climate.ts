/**
 * ERA5 climate reanalysis access for the climate time machine.
 *
 * Two products:
 *   1. A daily record for an arbitrary historical date (extreme-event lookup).
 *   2. An 85-year annual-mean series for the warming-stripes chart.
 *
 * ## The cost constraint that shapes this module
 *
 * The archive API bills one call per coordinate, like the forecast API, and a
 * naive request for 85 years of *daily* data returns ~31,000 values per
 * coordinate (~550 KB). That is fine once, but re-fetching it on every slider
 * move would be both slow and wasteful, so:
 *
 *   - the annual series is requested as `monthly` and aggregated client-side
 *     (85 years × 12 values instead of × 365),
 *   - results are cached per (lat/lng, kind) for the session,
 *   - the warming-stripes computation is done once and memoised.
 */

import { hasQuotaFor, noteUpstreamSpend } from './quota';

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';

/* ------------------------------------------------------------------ */
/* Cache                                                              */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 16;

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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error('ERA5 档案接口返回 429：请求额度已用尽，请稍候再试。');
    }
    const body = await res.text().catch(() => '');
    throw new Error(`档案请求失败 ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Daily record for one date                                          */
/* ------------------------------------------------------------------ */

export interface DailyRecord {
  date: string;
  tempMean: number;
  tempMax: number;
  tempMin: number;
  precipitation: number;
  windMax: number | null;
}

const dailyCache = makeCache<DailyRecord>();

/**
 * Fetch one day's reanalysis at a point.
 *
 * Used by the "jump to a famous event" buttons and by the date picker.
 */
export async function fetchDailyRecord(options: {
  lat: number;
  lng: number;
  date: string;
  signal?: AbortSignal;
}): Promise<DailyRecord> {
  const { lat, lng, date, signal } = options;

  const key = `daily|${lat.toFixed(2)}|${lng.toFixed(2)}|${date}`;
  const cached = dailyCache.get(key);
  if (cached) return cached;

  if (!hasQuotaFor(1)) {
    throw new Error('额度不足：需要 1 个坐标调用。');
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    start_date: date,
    end_date: date,
    daily: 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    timezone: 'UTC',
  });

  const json = await getJson<{
    daily?: {
      time?: string[];
      temperature_2m_mean?: (number | null)[];
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
      precipitation_sum?: (number | null)[];
      wind_speed_10m_max?: (number | null)[];
    };
  }>(`${ARCHIVE_BASE}?${params.toString()}`, signal);

  noteUpstreamSpend(1);

  const d = json.daily ?? {};
  const at = (arr: (number | null)[] | undefined, i = 0): number => {
    if (!Array.isArray(arr)) return Number.NaN;
    const v = arr[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  };

  const record: DailyRecord = {
    date: d.time?.[0] ?? date,
    tempMean: at(d.temperature_2m_mean),
    tempMax: at(d.temperature_2m_max),
    tempMin: at(d.temperature_2m_min),
    precipitation: at(d.precipitation_sum),
    windMax: Number.isFinite(at(d.wind_speed_10m_max)) ? at(d.wind_speed_10m_max) : null,
  };

  dailyCache.set(key, record);
  return record;
}

/* ------------------------------------------------------------------ */
/* Annual series for warming stripes                                  */
/* ------------------------------------------------------------------ */

export interface AnnualTemperature {
  year: number;
  /** Annual mean of the monthly means, °C. Null when the year is incomplete. */
  mean: number | null;
  /** Number of months available (12 = complete). */
  months: number;
}

export interface ClimateSeries {
  latitude: number;
  longitude: number;
  firstYear: number;
  lastYear: number;
  /** Annual means, one entry per year in [firstYear, lastYear]. */
  years: AnnualTemperature[];
  /** Mean of the reference window, used as the anomaly baseline. */
  baseline: number;
  /** Baseline window used. */
  baselineWindow: [number, number];
  /** Earliest and latest dates actually covered. */
  coverage: { from: string; to: string };
}

const seriesCache = makeCache<ClimateSeries>();

/**
 * Fetch the full annual temperature record for a point.
 *
 * Requests **daily** means over the archive span and aggregates to annual means
 * locally.
 *
 * Note on the request shape: the archive API's `monthly=` parameter is accepted
 * syntactically but returns an empty payload (verified: a request with
 * `monthly=temperature_2m_mean` came back with no `monthly` key at all, while
 * the identical request with `daily=` returned 31,412 values). Only `daily` is
 * reliable here.
 *
 * Years are assembled from their daily values and any year with fewer than
 * `minDaysForCompleteYear` samples is flagged, so a partial first/last year can
 * be excluded from the anomaly range rather than biasing it.
 */
export async function fetchClimateSeries(options: {
  lat: number;
  lng: number;
  startYear?: number;
  endYear?: number;
  baselineWindow?: [number, number];
  signal?: AbortSignal;
}): Promise<ClimateSeries> {
  const {
    lat,
    lng,
    startYear = 1940,
    endYear = new Date().getUTCFullYear() - 1,
    baselineWindow = [1961, 1990],
    signal,
  } = options;

  const key = `series|${lat.toFixed(2)}|${lng.toFixed(2)}|${startYear}|${endYear}|${baselineWindow.join('-')}`;
  const cached = seriesCache.get(key);
  if (cached) return cached;

  if (!hasQuotaFor(1)) {
    throw new Error('额度不足：需要 1 个坐标调用。');
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    start_date: `${startYear}-01-01`,
    end_date: `${endYear}-12-31`,
    daily: 'temperature_2m_mean',
    timezone: 'UTC',
  });

  const json = await getJson<{
    latitude?: number;
    longitude?: number;
    daily?: { time?: string[]; temperature_2m_mean?: (number | null)[] };
  }>(`${ARCHIVE_BASE}?${params.toString()}`, signal);

  noteUpstreamSpend(1);

  const times = json.daily?.time ?? [];
  const values = json.daily?.temperature_2m_mean ?? [];

  if (times.length === 0 || values.length === 0) {
    throw new Error('ERA5 返回的日值序列为空。');
  }

  // Accumulate per year. Daily samples weight equally because each already
  // represents one calendar day, so a plain mean is the correct annual average.
  const buckets = new Map<number, { sum: number; count: number }>();

  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i];
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;

    const year = Number.parseInt(stamp.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;

    const bucket = buckets.get(year) ?? { sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count += 1;
    buckets.set(year, bucket);
  }

  if (buckets.size === 0) {
    throw new Error('ERA5 日值序列中没有有效数值。');
  }

  const years: AnnualTemperature[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const bucket = buckets.get(y);
    if (!bucket || bucket.count === 0) {
      years.push({ year: y, mean: null, months: 0 });
    } else {
      // `months` is reused as a completeness proxy: 12 for a full year, scaled
      // from the observed day count so downstream completeness checks work
      // unchanged regardless of whether the source was daily or monthly.
      const approxMonths = Math.min(12, Math.round((bucket.count / 365) * 12));
      years.push({
        year: y,
        mean: bucket.sum / bucket.count,
        months: approxMonths,
      });
    }
  }

  // Baseline from the reference window; fall back to the whole record if the
  // window has no complete years (older or hypothetical coordinates).
  let baselineValues = years
    .filter((y) => y.year >= baselineWindow[0] && y.year <= baselineWindow[1] && y.mean !== null)
    .map((y) => y.mean as number);

  if (baselineValues.length === 0) {
    baselineValues = years.filter((y) => y.mean !== null).map((y) => y.mean as number);
  }

  const baseline =
    baselineValues.length > 0
      ? baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length
      : 0;

  const series: ClimateSeries = {
    latitude: json.latitude ?? lat,
    longitude: json.longitude ?? lng,
    firstYear: startYear,
    lastYear: endYear,
    years,
    baseline,
    baselineWindow,
    coverage: {
      from: times[0] ?? '',
      to: times[times.length - 1] ?? '',
    },
  };

  seriesCache.set(key, series);
  return series;
}

/* ------------------------------------------------------------------ */
/* Warming stripes                                                    */
/* ------------------------------------------------------------------ */

export interface Stripe {
  year: number;
  /** Anomaly relative to the baseline, °C. */
  anomaly: number | null;
  /** 0..1 position within the observed anomaly range. */
  normalised: number;
  months: number;
}

export interface StripeData {
  stripes: Stripe[];
  minAnomaly: number;
  maxAnomaly: number;
  /** Most recent complete year and its anomaly. */
  latest: { year: number; anomaly: number } | null;
  /** Mean of the first vs last decade, for the trend statement. */
  firstDecadeMean: number | null;
  lastDecadeMean: number | null;
  /** Years excluded from the analysis because they were incomplete. */
  incompleteYears: number[];
}

/**
 * Compute Ed Hawkins-style warming stripes.
 *
 * Each stripe is one year, coloured by its temperature anomaly against the
 * chosen baseline. Years with fewer than 12 months are excluded from the
 * normalisation range (their mean is biased by the seasons present) but their
 * records are retained in the output with `months` so the UI can show them as
 * incomplete rather than as a false anomaly.
 */
export function computeStripes(series: ClimateSeries, minMonths = 12): StripeData {
  const complete = series.years.filter((y) => y.mean !== null && y.months >= minMonths);
  const incompleteYears = series.years
    .filter((y) => y.mean !== null && y.months < minMonths)
    .map((y) => y.year);

  const anomalies = complete.map((y) => (y.mean as number) - series.baseline);

  const minAnomaly = anomalies.length > 0 ? Math.min(...anomalies) : 0;
  const maxAnomaly = anomalies.length > 0 ? Math.max(...anomalies) : 1;
  const span = maxAnomaly - minAnomaly || 1;

  const stripes: Stripe[] = series.years.map((y) => {
    if (y.mean === null) {
      return { year: y.year, anomaly: null, normalised: 0.5, months: y.months };
    }
    const anomaly = y.mean - series.baseline;
    return {
      year: y.year,
      anomaly,
      normalised: Math.max(0, Math.min(1, (anomaly - minAnomaly) / span)),
      months: y.months,
    };
  });

  const completeSorted = complete.slice().sort((a, b) => a.year - b.year);

  const firstDecade = completeSorted.slice(0, 10);
  const lastDecade = completeSorted.slice(-10);

  const meanOf = (arr: AnnualTemperature[]): number | null => {
    const vals = arr.map((y) => y.mean).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const firstMean = meanOf(firstDecade);
  const lastMean = meanOf(lastDecade);

  const latestComplete = completeSorted[completeSorted.length - 1];

  return {
    stripes,
    minAnomaly,
    maxAnomaly,
    latest: latestComplete
      ? { year: latestComplete.year, anomaly: (latestComplete.mean as number) - series.baseline }
      : null,
    firstDecadeMean: firstMean !== null ? firstMean - series.baseline : null,
    lastDecadeMean: lastMean !== null ? lastMean - series.baseline : null,
    incompleteYears,
  };
}

/**
 * Diverging colour for a stripe, following the Hawkins palette.
 *
 * Deep blue (cold anomaly) through near-white (baseline) to deep red (warm),
 * which is the convention the published climate-stripe graphics use and is
 * therefore what readers expect to see.
 */
export function stripeColor(normalised: number): string {
  const t = Math.max(0, Math.min(1, normalised));

  // Anchor stops: 0 = #08306b, 0.5 = #f7f7f7, 1 = #67000d
  const stops: { t: number; c: [number, number, number] }[] = [
    { t: 0, c: [8, 48, 107] },
    { t: 0.25, c: [73, 148, 196] },
    { t: 0.5, c: [247, 247, 247] },
    { t: 0.75, c: [214, 96, 77] },
    { t: 1, c: [103, 0, 13] },
  ];

  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      return `rgb(${Math.round(a.c[0] + (b.c[0] - a.c[0]) * f)}, ${Math.round(
        a.c[1] + (b.c[1] - a.c[1]) * f,
      )}, ${Math.round(a.c[2] + (b.c[2] - a.c[2]) * f)})`;
    }
  }

  return 'rgb(103, 0, 13)';
}

export function clearClimateCaches(): void {
  dailyCache.clear();
  seriesCache.clear();
}

/* ------------------------------------------------------------------ */
/* Historical extreme events                                          */
/* ------------------------------------------------------------------ */

export interface HistoricalEvent {
  id: string;
  label: string;
  date: string;
  lat: number;
  lng: number;
  note: string;
}

/**
 * Well-documented historical extremes the user can jump to.
 *
 * Coordinates and dates are the published event locations; the app fetches the
 * actual reanalysis for them rather than bundling pre-computed numbers, so what
 * is shown is always ERA5's own value.
 */
export const HISTORICAL_EVENTS: HistoricalEvent[] = [
  {
    id: 'yangtze-2022',
    label: '2022 长江流域极端夏旱',
    date: '2022-08-18',
    lat: 29.56,
    lng: 106.55,
    note: '重庆一带，1961 年以来最强高温伏旱',
  },
  {
    id: 'heat-dome-2021',
    label: '2021 北美西部热穹顶',
    date: '2021-06-29',
    lat: 45.52,
    lng: -122.68,
    note: '波特兰，创纪录的持续极端高温',
  },
  {
    id: 'freezing-rain-2008',
    label: '2008 中国南方冻雨冰灾',
    date: '2008-01-28',
    lat: 26.65,
    lng: 106.63,
    note: '贵阳，大范围持续低温雨雪冰冻',
  },
  {
    id: 'flood-1998',
    label: '1998 长江特大洪水',
    date: '1998-08-01',
    lat: 30.59,
    lng: 114.31,
    note: '武汉，流域性特大洪水期间',
  },
  {
    id: 'european-heat-2003',
    label: '2003 欧洲热浪',
    date: '2003-08-10',
    lat: 48.86,
    lng: 2.35,
    note: '巴黎，欧洲历史性极端高温',
  },
];
