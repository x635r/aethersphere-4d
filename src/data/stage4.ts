/**
 * Stage 4 data access: aviation hazards (SIGMET / METAR / PIREP), live flights,
 * and space weather (aurora oval + Kp index).
 *
 * Everything here is keyless. The AWC endpoints go through our same-origin proxy
 * (`/api/awc/*`) because AviationWeather.gov sends no CORS headers and rejects
 * requests lacking a self-identifying User-Agent.
 */

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 3 * 60 * 1000;

interface Entry<T> {
  at: number;
  value: T;
}

function makeCache<T>(max = 24) {
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

/**
 * Thrown when the proxy reports that an upstream refused the edge connection.
 *
 * Distinguished from a generic failure so the UI can name the real cause —
 * "OpenSky blocked the edge" is actionable, "502" is not.
 */
export class UpstreamBlockedError extends Error {
  readonly edgeBlocked: boolean;
  readonly upstreamStatus: number | null;

  constructor(message: string, edgeBlocked: boolean, upstreamStatus: number | null) {
    super(message);
    this.name = 'UpstreamBlockedError';
    this.edgeBlocked = edgeBlocked;
    this.upstreamStatus = upstreamStatus;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });

  if (!res.ok) {
    // The proxy returns a JSON body describing why it failed; read it so the
    // reason reaches the panel instead of being flattened into a status code.
    let reason = `${res.status} ${res.statusText}`;
    let edgeBlocked = false;
    let upstreamStatus: number | null = null;

    try {
      const body = (await res.json()) as {
        reason?: string;
        edgeBlocked?: boolean;
        upstreamStatus?: number;
      };
      if (typeof body.reason === 'string') reason = body.reason;
      edgeBlocked = Boolean(body.edgeBlocked);
      upstreamStatus = typeof body.upstreamStatus === 'number' ? body.upstreamStatus : null;
    } catch {
      /* body was not JSON; keep the status line */
    }

    throw new UpstreamBlockedError(
      `${reason} (${url.replace(/\?.*$/, '')})`,
      edgeBlocked,
      upstreamStatus,
    );
  }

  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Aviation: SIGMET / AIRMET                                          */
/* ------------------------------------------------------------------ */

/** Hazard classes the map renders, with their display styling. */
export const HAZARD_STYLES = {
  TS: { label: '雷暴对流', short: 'TS', color: '#f97316', glow: 'rgba(249,115,22,0.55)' },
  TURB: { label: '晴空颠簸', short: 'TURB', color: '#facc15', glow: 'rgba(250,204,21,0.5)' },
  ICE: { label: '积冰', short: 'ICE', color: '#67e8f9', glow: 'rgba(103,232,249,0.5)' },
  VA: { label: '火山灰', short: 'VA', color: '#a855f7', glow: 'rgba(168,85,247,0.55)' },
  TC: { label: '热带气旋', short: 'TC', color: '#ef4444', glow: 'rgba(239,68,68,0.55)' },
  MTW: { label: '山地波', short: 'MTW', color: '#94a3b8', glow: 'rgba(148,163,184,0.4)' },
  ICING: { label: '积冰', short: 'ICE', color: '#67e8f9', glow: 'rgba(103,232,249,0.5)' },
  CONVECTIVE: { label: '雷暴对流', short: 'TS', color: '#f97316', glow: 'rgba(249,115,22,0.55)' },
} as const;

export type HazardCode = keyof typeof HAZARD_STYLES;

export interface HazardPolygon {
  id: string;
  hazard: HazardCode;
  qualifier: string;
  firName: string;
  /** Lower limit, feet. 0 = surface. */
  base: number;
  /** Upper limit, feet. */
  top: number;
  validFrom: number;
  validTo: number;
  raw: string;
  /** Rings of [lng, lat]. */
  rings: [number, number][][];
}

export interface HazardCollection {
  hazards: HazardPolygon[];
  counts: Record<string, number>;
  fetchedAt: number;
}

const hazardCache = makeCache<HazardCollection>();

interface AwcSigmetFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    icaoId?: string;
    firName?: string;
    hazard?: string;
    qualifier?: string;
    base?: number;
    top?: number;
    validTimeFrom?: string;
    validTimeTo?: string;
    rawSigmet?: string;
    seriesId?: string;
  };
}

/** Normalise the many hazard spellings AWC uses into our style keys. */
function normaliseHazard(raw: string | undefined): HazardCode {
  const h = (raw ?? '').toUpperCase();
  if (h.includes('CONVECTIVE') || h === 'TS') return 'TS';
  if (h.includes('TURB')) return 'TURB';
  if (h.includes('ICE')) return 'ICE';
  if (h.includes('VA') || h.includes('VOLCANIC')) return 'VA';
  if (h === 'TC' || h.includes('TROPICAL')) return 'TC';
  if (h.includes('MTW')) return 'MTW';
  return 'TURB';
}

/** Extract polygon rings from a Polygon or MultiPolygon geometry. */
function extractRings(geometry: AwcSigmetFeature['geometry']): [number, number][][] {
  if (!geometry) return [];

  if (geometry.type === 'Polygon') {
    return (geometry.coordinates as [number, number][][]).map((ring) =>
      ring.map(([lng, lat]) => [lng, lat] as [number, number]),
    );
  }

  if (geometry.type === 'MultiPolygon') {
    const out: [number, number][][] = [];
    for (const poly of geometry.coordinates as [number, number][][][]) {
      for (const ring of poly) {
        out.push(ring.map(([lng, lat]) => [lng, lat] as [number, number]));
      }
    }
    return out;
  }

  return [];
}

/**
 * Fetch global SIGMET hazards through the proxy.
 *
 * AWC returns ~130 active SIGMETs globally; the hazard mix is dominated by
 * convective (TS) and turbulence (TURB), which is what the colour mapping
 * emphasises.
 */
export async function fetchHazards(signal?: AbortSignal): Promise<HazardCollection> {
  const cached = hazardCache.get('global');
  if (cached) return cached;

  const json = await getJson<{ features?: AwcSigmetFeature[] }>(
    '/api/awc/isigmet?format=geojson',
    signal,
  );

  const hazards: HazardPolygon[] = [];
  const counts: Record<string, number> = {};

  for (const [index, feature] of (json.features ?? []).entries()) {
    const rings = extractRings(feature.geometry);
    if (rings.length === 0) continue;

    const hazard = normaliseHazard(feature.properties.hazard);
    counts[hazard] = (counts[hazard] ?? 0) + 1;

    hazards.push({
      id: `${feature.properties.icaoId ?? 'sigmet'}-${feature.properties.seriesId ?? index}`,
      hazard,
      qualifier: feature.properties.qualifier ?? '',
      firName: feature.properties.firName ?? feature.properties.icaoId ?? '',
      base: feature.properties.base ?? 0,
      top: feature.properties.top ?? 40000,
      validFrom: feature.properties.validTimeFrom
        ? Date.parse(feature.properties.validTimeFrom)
        : Number.NaN,
      validTo: feature.properties.validTimeTo
        ? Date.parse(feature.properties.validTimeTo)
        : Number.NaN,
      raw: feature.properties.rawSigmet ?? '',
      rings,
    });
  }

  const collection: HazardCollection = { hazards, counts, fetchedAt: Date.now() };
  hazardCache.set('global', collection);
  return collection;
}

/* ------------------------------------------------------------------ */
/* Aviation: METAR / flight category                                  */
/* ------------------------------------------------------------------ */

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';

export const FLIGHT_CATEGORY_STYLES: Record<
  FlightCategory,
  { label: string; color: string; description: string }
> = {
  VFR: { label: 'VFR 目视', color: '#22c55e', description: '云底 >3000ft 且能见度 >5SM' },
  MVFR: { label: 'MVFR 边缘目视', color: '#3b82f6', description: '云底 1000–3000ft 或能见度 3–5SM' },
  IFR: { label: 'IFR 仪表', color: '#ef4444', description: '云底 500–1000ft 或能见度 1–3SM' },
  LIFR: { label: 'LIFR 低仪表', color: '#e879f9', description: '云底 <500ft 或能见度 <1SM' },
};

export interface AirportObservation {
  icao: string;
  site: string;
  lat: number;
  lng: number;
  /** Provided by AWC directly; we do not re-derive it. */
  category: FlightCategory;
  temperature: number | null;
  dewPoint: number | null;
  windDir: number | null;
  windSpeedKt: number | null;
  gustKt: number | null;
  visibility: string | null;
  ceilingFt: number | null;
  altimeter: number | null;
  raw: string;
  observedAt: number;
  clouds: { cover: string; base: number }[];
}

interface AwcMetarFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    id?: string;
    site?: string;
    obsTime?: string;
    temp?: number | null;
    dewp?: number | null;
    wdir?: number | null;
    wspd?: number | null;
    wgst?: number | null;
    ceil?: number | null;
    cover?: string | null;
    fltcat?: string | null;
    visib?: string | number | null;
    altim?: number | null;
    rawOb?: string;
    clouds?: { cover: string; base: number }[];
  };
}

/** Map AWC's `fltcat` string onto our union, defaulting sensibly. */
function parseCategory(raw: string | null | undefined): FlightCategory {
  const c = (raw ?? '').toUpperCase();
  if (c === 'VFR' || c === 'MVFR' || c === 'IFR' || c === 'LIFR') return c;
  return 'VFR';
}

const metarCache = makeCache<AirportObservation[]>();

/**
 * Fetch METARs for a bounding box.
 *
 * Bounds are required because a global query returns tens of thousands of
 * stations and heavily rate-limits. The UI therefore refreshes on viewport
 * change rather than polling the whole planet.
 */
export async function fetchMetars(options: {
  west: number;
  south: number;
  east: number;
  north: number;
  signal?: AbortSignal;
}): Promise<AirportObservation[]> {
  const { west, south, east, north, signal } = options;

  // Round to whole degrees so panning a few pixels reuses the cache.
  const bbox = `${Math.round(south)},${Math.round(west)},${Math.round(north)},${Math.round(east)}`;
  const cached = metarCache.get(bbox);
  if (cached) return cached;

  const json = await getJson<{ features?: AwcMetarFeature[] }>(
    `/api/awc/metar?bbox=${bbox}&format=geojson`,
    signal,
  );

  const stations: AirportObservation[] = [];

  for (const feature of json.features ?? []) {
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;

    const p = feature.properties;
    const visRaw = p.visib;

    stations.push({
      icao: p.id ?? '????',
      site: p.site ?? '',
      lng: coords[0],
      lat: coords[1],
      category: parseCategory(p.fltcat),
      temperature: typeof p.temp === 'number' ? p.temp : null,
      dewPoint: typeof p.dewp === 'number' ? p.dewp : null,
      windDir: typeof p.wdir === 'number' ? p.wdir : null,
      windSpeedKt: typeof p.wspd === 'number' ? p.wspd : null,
      gustKt: typeof p.wgst === 'number' ? p.wgst : null,
      visibility: visRaw === null || visRaw === undefined ? null : String(visRaw),
      ceilingFt: typeof p.ceil === 'number' ? p.ceil : null,
      altimeter: typeof p.altim === 'number' ? p.altim : null,
      raw: p.rawOb ?? '',
      observedAt: p.obsTime ? Date.parse(p.obsTime) : Date.now(),
      clouds: p.clouds ?? [],
    });
  }

  metarCache.set(bbox, stations);
  return stations;
}

/* ------------------------------------------------------------------ */
/* Aviation: PIREP                                                     */
/* ------------------------------------------------------------------ */

export interface PirepReport {
  id: string;
  lat: number;
  lng: number;
  type: string;
  aircraft: string;
  /** True when the raw text indicates turbulence. */
  turbulence: boolean;
  /** True when the raw text indicates icing. */
  icing: boolean;
  raw: string;
  observedAt: number;
  altitude: number | null;
}

const pirepCache = makeCache<PirepReport[]>();

/**
 * Fetch PIREPs for a bounding box and classify turbulence/icing from the raw
 * text.
 *
 * AWC does not expose structured turbulence severity, so it is inferred from
 * the observation body. The patterns below match the abbreviations used in
 * real PIREPs (`TB`, `CHOP`, `IC`).
 */
export async function fetchPireps(options: {
  west: number;
  south: number;
  east: number;
  north: number;
  signal?: AbortSignal;
}): Promise<PirepReport[]> {
  const { west, south, east, north, signal } = options;
  const bbox = `${Math.round(south)},${Math.round(west)},${Math.round(north)},${Math.round(east)}`;

  const cached = pirepCache.get(bbox);
  if (cached) return cached;

  const json = await getJson<{
    features?: {
      geometry: { coordinates: [number, number] } | null;
      properties: Record<string, unknown>;
    }[];
  }>(`/api/awc/pirep?bbox=${bbox}&format=geojson`, signal);

  const reports: PirepReport[] = [];

  for (const [index, feature] of (json.features ?? []).entries()) {
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;

    const raw = String(feature.properties.rawOb ?? '');
    const upper = raw.toUpperCase();

    reports.push({
      id: `${feature.properties.icaoId ?? 'pirep'}-${index}`,
      lng: coords[0],
      lat: coords[1],
      type: String(feature.properties.airepType ?? 'PIREP'),
      aircraft: String(feature.properties.aircraft ?? ''),
      turbulence: /\bTB\b|\bTURB\b|\bCHOP\b/.test(upper),
      icing: /\bIC\b|\bICE\b/.test(upper),
      raw,
      observedAt: feature.properties.obsTime
        ? Date.parse(String(feature.properties.obsTime))
        : Date.now(),
      altitude: typeof feature.properties.fltlvl === 'number' ? feature.properties.fltlvl : null,
    });
  }

  pirepCache.set(bbox, reports);
  return reports;
}

/* ------------------------------------------------------------------ */
/* Live flights (OpenSky)                                             */
/* ------------------------------------------------------------------ */

export interface FlightState {
  icao24: string;
  callsign: string;
  country: string;
  lng: number;
  lat: number;
  /** Barometric altitude, metres. Null while on the ground. */
  altitudeM: number | null;
  onGround: boolean;
  velocityMs: number | null;
  /** True track over ground, degrees clockwise from north. */
  heading: number | null;
  verticalRate: number | null;
}

export interface FlightCollection {
  flights: FlightState[];
  time: number;
}

const flightCache = makeCache<FlightCollection>(8);

/**
 * Fetch live flight positions from OpenSky for a bounding box.
 *
 * Anonymous access works but is rate-limited (roughly 100 requests per 15
 * minutes), so the caller must not poll faster than every ~30 s.
 *
 * OpenSky's `states` array is positional, not an object — the index constants
 * below are the documented field order and must not be reordered.
 */
export async function fetchFlights(options: {
  west: number;
  south: number;
  east: number;
  north: number;
  signal?: AbortSignal;
  /** Bypass the in-memory cache (used by the manual refresh button). */
  force?: boolean;
}): Promise<FlightCollection> {
  const { west, south, east, north, signal, force = false } = options;

  const key = `${Math.round(south)},${Math.round(west)},${Math.round(north)},${Math.round(east)}`;
  if (!force) {
    const cached = flightCache.get(key);
    if (cached) return cached;
  }

  const params = new URLSearchParams({
    lamin: south.toFixed(2),
    lomin: west.toFixed(2),
    lamax: north.toFixed(2),
    lomax: east.toFixed(2),
  });

  // OpenSky only allows its own origin via CORS, so the request is routed
  // through our proxy. A direct call fails with an opaque "Failed to fetch"
  // that looks like a network outage rather than a CORS rejection — verified by
  // inspecting the response headers (`Access-Control-Allow-Origin:
  // https://opensky-network.org`).
  const json = await getJson<{ time: number; states: unknown[][] | null }>(
    `/api/awc/opensky/states/all?${params.toString()}`,
    signal,
  );

  // Positional field indices per the OpenSky REST documentation.
  const IDX = {
    icao24: 0,
    callsign: 1,
    country: 2,
    lon: 5,
    lat: 6,
    altitude: 7,
    onGround: 8,
    velocity: 9,
    heading: 10,
    verticalRate: 11,
  } as const;

  const flights: FlightState[] = [];

  for (const row of json.states ?? []) {
    const lng = row[IDX.lon] as number | null;
    const lat = row[IDX.lat] as number | null;
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;

    flights.push({
      icao24: String(row[IDX.icao24] ?? ''),
      callsign: String(row[IDX.callsign] ?? '').trim(),
      country: String(row[IDX.country] ?? ''),
      lng,
      lat,
      altitudeM: typeof row[IDX.altitude] === 'number' ? (row[IDX.altitude] as number) : null,
      onGround: Boolean(row[IDX.onGround]),
      velocityMs: typeof row[IDX.velocity] === 'number' ? (row[IDX.velocity] as number) : null,
      heading: typeof row[IDX.heading] === 'number' ? (row[IDX.heading] as number) : null,
      verticalRate:
        typeof row[IDX.verticalRate] === 'number' ? (row[IDX.verticalRate] as number) : null,
    });
  }

  const collection: FlightCollection = { flights, time: json.time };
  flightCache.set(key, collection);
  return collection;
}

/* ------------------------------------------------------------------ */
/* Space weather: aurora                                              */
/* ------------------------------------------------------------------ */

export interface AuroraGrid {
  /** Longitude in [-180, 180). */
  longitude: number[];
  /** Latitude in [-90, 90]. */
  latitude: number[];
  /** Probability 0..100, row-major [latIndex][lonIndex]. */
  probability: Float32Array;
  cols: number;
  rows: number;
  observedAt: number;
  forecastAt: number;
  /** Peak probability anywhere on the grid. */
  peak: number;
  /** Mean of all non-zero probabilities, for legend calibration. */
  nonZeroMean: number;
}

const auroraCache = makeCache<AuroraGrid>(2);

/**
 * Fetch and reshape the OVATION aurora probability field.
 *
 * The raw payload is 65,160 triples `[lon_0_to_359, lat_-90_to_90, prob]`
 * ordered longitude-major (all latitudes for lon 0, then lon 1, ...). It is
 * transposed here into a lat-major grid so it can be drawn as an image with
 * north at the top.
 *
 * Real-world note: under quiet conditions the peak probability is around 25–30
 * and nothing exceeds ~60. The colour ramp must therefore be calibrated to the
 * actual data; a fixed ">=60 is purple" scale would render every quiet day as a
 * flat green smear.
 */
export async function fetchAuroraGrid(signal?: AbortSignal): Promise<AuroraGrid> {
  const cached = auroraCache.get('ovation');
  if (cached) return cached;

  const json = await getJson<{
    'Observation Time'?: string;
    'Forecast Time'?: string;
    coordinates?: [number, number, number][];
  }>('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', signal);

  const coords = json.coordinates ?? [];
  if (coords.length === 0) throw new Error('极光网格为空');

  // The payload is 360 longitudes x 181 latitudes = 65,160 points.
  const cols = 360;
  const rows = 181;

  const latitudeValues = new Float32Array(cols * rows);
  const probability = new Float32Array(cols * rows);

  let peak = 0;
  let sum = 0;
  let nonZero = 0;

  for (const [lon, lat, prob] of coords) {
    // Longitude 0..359 -> -180..179
    const lonIdx = ((Math.round(lon) + 180) % 360 + 360) % 360;
    // Latitude -90..90 -> row 0 is the south pole.
    const latIdx = Math.round(lat) + 90;

    if (lonIdx < 0 || lonIdx >= cols || latIdx < 0 || latIdx >= rows) continue;

    const index = latIdx * cols + lonIdx;
    probability[index] = prob;
    latitudeValues[index] = lat;

    if (prob > peak) peak = prob;
    if (prob > 0) {
      sum += prob;
      nonZero += 1;
    }
  }

  const longitude: number[] = [];
  for (let c = 0; c < cols; c += 1) longitude.push(c - 180);

  const latitude: number[] = [];
  for (let r = 0; r < rows; r += 1) latitude.push(r - 90);

  const grid: AuroraGrid = {
    longitude,
    latitude,
    probability,
    cols,
    rows,
    observedAt: json['Observation Time'] ? Date.parse(json['Observation Time']) : Date.now(),
    forecastAt: json['Forecast Time'] ? Date.parse(json['Forecast Time']) : Date.now(),
    peak,
    nonZeroMean: nonZero > 0 ? sum / nonZero : 0,
  };

  auroraCache.set('ovation', grid);
  return grid;
}

/** Aurora probability at a specific location, bilinearly interpolated. */
export function sampleAurora(grid: AuroraGrid, lng: number, lat: number): number {
  const x = ((lng + 180) / 360) * grid.cols - 0.5;
  const y = ((lat + 90) / 180) * (grid.rows - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const wrap = (v: number) => ((v % grid.cols) + grid.cols) % grid.cols;
  const clampI = (v: number) => (v < 0 ? 0 : v > grid.rows - 1 ? grid.rows - 1 : v);

  const c0 = wrap(x0);
  const c1 = wrap(x0 + 1);
  const r0 = clampI(y0);
  const r1 = clampI(y0 + 1);

  const v00 = grid.probability[r0 * grid.cols + c0];
  const v10 = grid.probability[r0 * grid.cols + c1];
  const v01 = grid.probability[r1 * grid.cols + c0];
  const v11 = grid.probability[r1 * grid.cols + c1];

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/* ------------------------------------------------------------------ */
/* Space weather: Kp                                                  */
/* ------------------------------------------------------------------ */

export interface KpSample {
  time: number;
  kp: number;
  /** Running a-index. */
  aRunning: number;
}

export interface KpSeries {
  samples: KpSample[];
  /** Latest observed Kp. */
  current: number;
  /** Peak Kp in the last 24 h. */
  max24h: number;
  /** NOAA G-scale derived from the current Kp. */
  level: GeomagneticLevel;
}

export interface GeomagneticLevel {
  g: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  color: string;
  description: string;
  /** Approximate aurora viewline latitude during this level (mid-latitudes). */
  viewlineLat: number;
}

const kpCache = makeCache<KpSeries>(2);

/** Map Kp onto the NOAA G-scale. */
export function geomagneticLevel(kp: number): GeomagneticLevel {
  if (!Number.isFinite(kp)) {
    return { g: 0, label: '—', color: '#64748b', description: '无数据', viewlineLat: 66 };
  }
  if (kp >= 9) {
    return { g: 5, label: 'G5 极端', color: '#a855f7', description: '电网可能大面积故障', viewlineLat: 40 };
  }
  if (kp >= 8) {
    return { g: 4, label: 'G4 严重', color: '#f43f5e', description: '高频通信中断', viewlineLat: 45 };
  }
  if (kp >= 7) {
    return { g: 3, label: 'G3 强', color: '#f97316', description: '卫星导航退化', viewlineLat: 50 };
  }
  if (kp >= 6) {
    return { g: 2, label: 'G2 中等', color: '#facc15', description: '高纬电力波动', viewlineLat: 55 };
  }
  if (kp >= 5) {
    return { g: 1, label: 'G1 轻微', color: '#a3e635', description: '弱电网扰动', viewlineLat: 60 };
  }
  return {
    g: 0,
    label: '平静',
    color: '#34d399',
    description: '地磁活动平静',
    viewlineLat: 66,
  };
}

/**
 * Fetch the planetary Kp series.
 *
 * The endpoint returns an array of objects with `time_tag`, `Kp`, `a_running`
 * and `station_count` — not the row/header layout used by some other SWPC
 * products.
 */
export async function fetchKpSeries(signal?: AbortSignal): Promise<KpSeries> {
  const cached = kpCache.get('kp');
  if (cached) return cached;

  const raw = await getJson<
    { time_tag: string; Kp: number | string; a_running?: number }[]
  >('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', signal);

  const samples: KpSample[] = [];

  for (const row of raw) {
    const kp = typeof row.Kp === 'number' ? row.Kp : Number.parseFloat(String(row.Kp));
    if (!Number.isFinite(kp)) continue;
    samples.push({
      time: Date.parse(`${row.time_tag}Z`),
      kp,
      aRunning: typeof row.a_running === 'number' ? row.a_running : 0,
    });
  }

  samples.sort((a, b) => a.time - b.time);

  const latest = samples[samples.length - 1];
  const current = latest ? latest.kp : Number.NaN;

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recent = samples.filter((s) => s.time >= dayAgo);
  const max24h = recent.length > 0 ? Math.max(...recent.map((s) => s.kp)) : current;

  const series: KpSeries = {
    samples,
    current,
    max24h,
    level: geomagneticLevel(Math.max(current, max24h)),
  };

  kpCache.set('kp', series);
  return series;
}

/* ------------------------------------------------------------------ */
/* Crosswind maths                                                    */
/* ------------------------------------------------------------------ */

export interface CrosswindResult {
  /** Crosswind component in knots (absolute). */
  crosswind: number;
  /** Headwind (positive) or tailwind (negative) in knots. */
  headwind: number;
  /** Gust crosswind, when a gust is reported. */
  gustCrosswind: number | null;
  /** Angle between wind and runway, degrees. */
  angle: number;
  /** Runway whose alignment is best suited to the wind. */
  bestRunway: { heading: number; crosswind: number } | null;
  severity: 'ok' | 'caution' | 'warning' | 'danger';
  note: string;
}

/**
 * Resolve wind components relative to a runway.
 *
 *     crosswind = V · sin(Δθ)
 *     headwind  = V · cos(Δθ)
 *
 * with Δθ = wind direction − runway heading. All inputs in knots/degrees.
 */
export function computeCrosswind(
  windDirDeg: number,
  windSpeedKt: number,
  runwayHeadingDeg: number,
  gustKt: number | null,
): CrosswindResult {
  if (!Number.isFinite(windDirDeg) || !Number.isFinite(windSpeedKt)) {
    return {
      crosswind: Number.NaN,
      headwind: Number.NaN,
      gustCrosswind: null,
      angle: Number.NaN,
      bestRunway: null,
      severity: 'ok',
      note: '无风数据',
    };
  }

  const delta = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  const crosswind = Math.abs(windSpeedKt * Math.sin(delta));
  const headwind = windSpeedKt * Math.cos(delta);
  const gustCrosswind =
    gustKt !== null && Number.isFinite(gustKt) ? Math.abs(gustKt * Math.sin(delta)) : null;

  // Evaluate the reciprocal runway too: the same wind produces an opposite
  // headwind/tailwind and the identical crosswind magnitude, so the useful
  // comparison is headwind vs tailwind, not crosswind.
  const reciprocalHeading = (runwayHeadingDeg + 180) % 360;
  const deltaRecip = ((windDirDeg - reciprocalHeading) * Math.PI) / 180;
  const headwindRecip = windSpeedKt * Math.cos(deltaRecip);

  const preferReciprocal = headwindRecip > headwind;
  const bestRunway = {
    heading: preferReciprocal ? reciprocalHeading : runwayHeadingDeg,
    crosswind: Math.abs(windSpeedKt * Math.sin(preferReciprocal ? deltaRecip : delta)),
  };

  // Gusts govern the operational limit, so severity uses the worst case.
  const effectiveCross = gustCrosswind !== null ? Math.max(crosswind, gustCrosswind) : crosswind;

  let severity: CrosswindResult['severity'] = 'ok';
  let note = '在常规运行限制内';

  if (effectiveCross > 35) {
    severity = 'danger';
    note = '远超多数机型侧风限制';
  } else if (effectiveCross > 25) {
    severity = 'warning';
    note = '超过 25kt，多数窄体机需换向';
  } else if (effectiveCross > 15) {
    severity = 'caution';
    note = '中等侧风，注意修正';
  }

  // A tailwind beyond 10 kt exceeds most operators' landing limit regardless
  // of how benign the crosswind is.
  const effectiveHeadwind = preferReciprocal ? headwindRecip : headwind;
  if (effectiveHeadwind < -10) {
    if (severity === 'ok') severity = 'caution';
    note = `顺风 ${Math.abs(effectiveHeadwind).toFixed(0)}kt，超过常见 10kt 限制`;
  }

  // Angle between the wind and the runway centreline, 0-180.
  const rawAngle = Math.abs(((windDirDeg - runwayHeadingDeg + 540) % 360) - 180);

  return {
    crosswind,
    headwind,
    gustCrosswind,
    angle: rawAngle,
    bestRunway,
    severity,
    note,
  };
}

/** Standard runway headings to evaluate when we have no runway database. */
export const CARDINAL_RUNWAYS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

export function clearStage4Caches(): void {
  hazardCache.clear();
  metarCache.clear();
  pirepCache.clear();
  flightCache.clear();
  auroraCache.clear();
  kpCache.clear();
}
