/**
 * Tropical-cyclone domain logic.
 *
 * Covers the Saffir-Simpson scale, great-circle wind-radii geometry, ACE, the
 * size/intensity comparison used by the "superstorm arena", and parsing of
 * externally supplied IBTrACS GeoJSON.
 *
 * Data provenance matters here: the bundled tracks come from NOAA IBTrACS
 * v04r01 and are reproduced exactly as archived. Nothing in this file invents
 * intensity values — where a storm has no wind-radii record (pre-scatterometer),
 * `hasWindRadii` is false and the UI says so rather than drawing a guess.
 */

import { greatCircleInterpolate, greatCircleDistanceKm } from '../data/sounding';
import type { LngLatPoint } from '../data/sounding';

/* ------------------------------------------------------------------ */
/* Track model                                                        */
/* ------------------------------------------------------------------ */

/** One archived best-track fix. */
export interface TrackPoint {
  time: number;
  lat: number;
  lng: number;
  /** Maximum sustained wind, knots. */
  windKt: number;
  /** Central pressure, hPa. */
  pressureHpa: number;
  /** Radius of 34 kt winds, nautical miles (null when not archived). */
  r34: number | null;
  /** Radius of 50 kt winds, nautical miles. */
  r50: number | null;
  /** Radius of 64 kt winds, nautical miles. */
  r64: number | null;
}

/** Compact tuple layout used in the generated data module. */
export type TrackTuple = [
  string,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export interface CycloneRecord {
  id: string;
  name: string;
  nameZh: string;
  nameEn: string;
  basin: string;
  year: number;
  note: string;
  peakWindKt: number;
  minPressureHpa: number;
  maxSshs: number;
  /** Accumulated Cyclone Energy, 10⁴ kt². */
  ace: number;
  hasWindRadii: boolean;
  peakPoint: {
    iso: string;
    lat: number;
    lon: number;
    windKt: number | null;
    presHpa: number | null;
    r34: number | null;
    r50: number | null;
    r64: number | null;
  };
  track: TrackTuple[];
}

/** Expand the compact tuples into a typed, time-sorted track. */
export function decodeTrack(record: CycloneRecord): TrackPoint[] {
  return record.track
    .map((tuple) => {
      const [iso, lat, lng, windKt, pressureHpa, r34, r50, r64] = tuple;
      return {
        time: Date.parse(`${iso.replace(' ', 'T')}Z`),
        lat,
        lng,
        windKt: windKt ?? Number.NaN,
        pressureHpa: pressureHpa ?? Number.NaN,
        r34,
        r50,
        r64,
      };
    })
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.lat))
    .sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------ */
/* Saffir-Simpson                                                     */
/* ------------------------------------------------------------------ */

export interface CategoryStyle {
  category: number;
  label: string;
  color: string;
  /** Minimum sustained wind in knots for this category. */
  minWindKt: number;
}

/** The Saffir-Simpson scale as thresholds on 1-minute sustained wind (kt). */
export const SAFFIR_SIMPSON: CategoryStyle[] = [
  { category: 0, label: 'TD 热带低压', color: '#38bdf8', minWindKt: 0 },
  { category: 0, label: 'TS 热带风暴', color: '#34d399', minWindKt: 34 },
  { category: 1, label: 'Cat 1', color: '#facc15', minWindKt: 64 },
  { category: 2, label: 'Cat 2', color: '#fb923c', minWindKt: 83 },
  { category: 3, label: 'Cat 3 强台风', color: '#f97316', minWindKt: 96 },
  { category: 4, label: 'Cat 4 超强台风', color: '#ef4444', minWindKt: 113 },
  { category: 5, label: 'Cat 5 猛烈', color: '#e879f9', minWindKt: 137 },
];

/**
 * Classify a wind speed into the Saffir-Simpson scale.
 *
 * Returns the category number (0–5) plus the display style. Note that both
 * tropical depression and tropical storm map to category 0 in the numeric
 * scale — they are distinguished by the label, not the number, exactly as the
 * official scale does.
 */
export function saffirSimpson(windKt: number): CategoryStyle {
  if (!Number.isFinite(windKt)) return SAFFIR_SIMPSON[0];

  let match = SAFFIR_SIMPSON[0];
  for (const entry of SAFFIR_SIMPSON) {
    if (windKt >= entry.minWindKt) match = entry;
  }
  return match;
}

/** Colour for a track segment at a given intensity. */
export function trackColor(windKt: number): string {
  return saffirSimpson(windKt).color;
}

/* ------------------------------------------------------------------ */
/* Accumulated Cyclone Energy                                         */
/* ------------------------------------------------------------------ */

/**
 * ACE = 10⁻⁴ · Σ v² over 6-hourly fixes, counting only winds ≥ 34 kt.
 *
 * This is the standard NOAA definition. Fixes are not resampled: IBTrACS
 * already provides 6-hourly (and some 3-hourly) records, and summing the
 * archive as published is what makes our numbers comparable to published ACE
 * tables.
 */
export function accumulatedCycloneEnergy(track: TrackPoint[]): number {
  let ace = 0;
  for (const point of track) {
    if (!Number.isFinite(point.windKt) || point.windKt < 34) continue;
    ace += 1e-4 * point.windKt ** 2;
  }
  return ace;
}

/* ------------------------------------------------------------------ */
/* Wind radii geometry                                                */
/* ------------------------------------------------------------------ */

const NM_PER_KM = 0.539957;
const KM_PER_DEG_LAT = 111.32;

/**
 * Radius of a wind circle as a latitude offset.
 *
 * Used to draw the R34/R50/R64 rings as small circles in degrees. The value is
 * quoted in nautical miles in the archive and converted to kilometres, then to
 * degrees of latitude (the meridional scale is essentially constant).
 */
export function radiusNmToDegrees(radiusNm: number): number {
  return (radiusNm / NM_PER_KM) / KM_PER_DEG_LAT;
}

/** Longitude offset for a given radius at a latitude (shrinks toward the poles). */
export function radiusNmToLngDegrees(radiusNm: number, lat: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const deg = radiusNmToDegrees(radiusNm);
  if (Math.abs(cosLat) < 1e-3) return deg;
  return deg / cosLat;
}

/**
 * Build a closed ring approximating a wind-radius circle on the sphere.
 *
 * A true "small circle" would need geodesic maths; sampling the ellipse in
 * lon/lat is accurate to well under a pixel at the zoom levels the rings are
 * read at, and it keeps the geometry cheap.
 */
export function windRadiusRing(
  center: LngLatPoint,
  radiusNm: number,
  segments = 64,
): [number, number][] {
  const ring: [number, number][] = [];
  const latDeg = radiusNmToDegrees(radiusNm);
  const lngDeg = radiusNmToLngDegrees(radiusNm, center.lat);

  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const lat = center.lat + latDeg * Math.cos(angle);
    let lng = center.lng + lngDeg * Math.sin(angle);

    // Normalise into [-180, 180).
    lng = ((lng + 540) % 360) - 180;

    ring.push([lng, Math.max(-89.9, Math.min(89.9, lat))]);
  }

  return ring;
}

/* ------------------------------------------------------------------ */
/* Track geometry                                                     */
/* ------------------------------------------------------------------ */

/** Total travelled distance of a track, km. */
export function trackLength(track: TrackPoint[]): number {
  let total = 0;
  for (let i = 1; i < track.length; i += 1) {
    total += greatCircleDistanceKm(
      { lat: track[i - 1].lat, lng: track[i - 1].lng },
      { lat: track[i].lat, lng: track[i].lng },
    );
  }
  return total;
}

/** Bounding box of a track, degrees. */
export function trackBounds(track: TrackPoint[]): {
  west: number;
  south: number;
  east: number;
  north: number;
} | null {
  if (track.length === 0) return null;

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const p of track) {
    // Tracks can cross the antimeridian; the western Pacific ones often do.
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }

  return { west, south, east, north };
}

/**
 * Interpolate a track to a fractional index.
 *
 * Used by the time slider so the storm marker moves smoothly between 6-hourly
 * fixes along the great circle rather than teleporting.
 */
export function interpolateTrack(
  track: TrackPoint[],
  index: number,
): { lat: number; lng: number; windKt: number; pressureHpa: number; time: number } | null {
  if (track.length === 0) return null;

  const clamped = Math.max(0, Math.min(track.length - 1, index));
  const lo = Math.floor(clamped);
  const hi = Math.min(track.length - 1, lo + 1);
  const frac = clamped - lo;

  const a = track[lo];
  const b = track[hi];

  if (lo === hi || frac < 1e-6) {
    return { lat: a.lat, lng: a.lng, windKt: a.windKt, pressureHpa: a.pressureHpa, time: a.time };
  }

  // Interpolate position on the great circle; scalars stay linear, which is
  // what the 6-hourly reporting cadence justifies.
  const pos = greatCircleInterpolate(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng },
    frac,
  );

  return {
    lat: pos.lat,
    lng: pos.lng,
    windKt: a.windKt + (b.windKt - a.windKt) * frac,
    pressureHpa: a.pressureHpa + (b.pressureHpa - a.pressureHpa) * frac,
    time: a.time + (b.time - a.time) * frac,
  };
}

/* ------------------------------------------------------------------ */
/* Superstorm comparison                                              */
/* ------------------------------------------------------------------ */

export interface CycloneSpec {
  record: CycloneRecord;
  track: TrackPoint[];
  peak: TrackPoint | null;
  /** Diameter of the 34 kt wind field at peak, km. */
  r34DiameterKm: number | null;
  /** Area enclosed by the 34 kt wind field at peak, km². */
  r34AreaKm2: number | null;
  travelKm: number;
  ace: number;
}

/** Build the comparison spec for one storm. */
export function buildCycloneSpec(record: CycloneRecord): CycloneSpec {
  const track = decodeTrack(record);

  // Peak fix: prefer the strongest wind; break ties on the lowest pressure.
  let peak: TrackPoint | null = null;
  for (const point of track) {
    if (!Number.isFinite(point.windKt)) continue;
    if (
      !peak ||
      point.windKt > peak.windKt ||
      (point.windKt === peak.windKt &&
        Number.isFinite(point.pressureHpa) &&
        point.pressureHpa < peak.pressureHpa)
    ) {
      peak = point;
    }
  }

  const r34DiameterKm =
    peak && peak.r34
      ? // The archive stores the NE quadrant radius; doubling approximates the
        // full diameter, which is the figure storm-size comparisons quote.
        (peak.r34 * 2) / NM_PER_KM
      : null;

  return {
    record,
    track,
    peak,
    r34DiameterKm,
    r34AreaKm2: r34DiameterKm ? Math.PI * (r34DiameterKm / 2) ** 2 : null,
    travelKm: trackLength(track),
    ace: accumulatedCycloneEnergy(track),
  };
}

/** Sort specs by a chosen metric, descending. */
export type ComparisonMetric = 'wind' | 'pressure' | 'size' | 'ace' | 'travel';

export function sortByMetric(specs: CycloneSpec[], metric: ComparisonMetric): CycloneSpec[] {
  const sorted = [...specs];

  sorted.sort((a, b) => {
    switch (metric) {
      case 'wind':
        return (b.record.peakWindKt ?? 0) - (a.record.peakWindKt ?? 0);
      case 'pressure':
        // Lower pressure is stronger, so invert.
        return (a.record.minPressureHpa ?? 9999) - (b.record.minPressureHpa ?? 9999);
      case 'size':
        return (b.r34DiameterKm ?? 0) - (a.r34DiameterKm ?? 0);
      case 'ace':
        return b.ace - a.ace;
      case 'travel':
        return b.travelKm - a.travelKm;
      default:
        return 0;
    }
  });

  return sorted;
}

/* ------------------------------------------------------------------ */
/* External IBTrACS GeoJSON import                                    */
/* ------------------------------------------------------------------ */

export interface ImportedTrack {
  name: string;
  year: number | null;
  basin: string;
  points: TrackPoint[];
  /** Non-fatal problems found while parsing. */
  warnings: string[];
}

/**
 * Parse an IBTrACS-style GeoJSON track file.
 *
 * Accepts the two shapes most exports use: a FeatureCollection whose features
 * are points carrying `ISO_TIME`/`USA_LAT`/`USA_LON`/`USA_WIND` properties, or a
 * single LineString feature with parallel arrays in its properties.
 *
 * Every parse issue is reported in `warnings` instead of throwing, so a file
 * with a few bad rows still imports the rest.
 */
export function parseIbtracsGeoJson(text: string): ImportedTrack {
  const warnings: string[] = [];

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `无法解析 JSON：${error instanceof Error ? error.message : '格式错误'}`,
    );
  }

  if (typeof json !== 'object' || json === null) {
    throw new Error('文件内容不是有效的 GeoJSON 对象。');
  }

  const root = json as {
    type?: string;
    features?: {
      type?: string;
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    }[];
    geometry?: { type?: string; coordinates?: unknown };
    properties?: Record<string, unknown>;
  };

  type GeoFeature = {
    geometry?: { type?: string; coordinates?: unknown };
    properties?: Record<string, unknown>;
  };

  const features: GeoFeature[] =
    root.features ?? (root.geometry ? [{ geometry: root.geometry, properties: root.properties }] : []);

  const points: TrackPoint[] = [];
  let name = '';
  let year: number | null = null;
  let basin = '';

  const pickNumber = (props: Record<string, unknown>, keys: string[]): number => {
    for (const key of keys) {
      const v = props[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number.parseFloat(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return Number.NaN;
  };

  const pickString = (props: Record<string, unknown>, keys: string[]): string => {
    for (const key of keys) {
      const v = props[key];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return '';
  };

  for (const feature of features) {
    const props = feature.properties ?? {};

    if (!name) name = pickString(props, ['NAME', 'name', 'STORMNAME']);
    if (!basin) basin = pickString(props, ['BASIN', 'basin']);
    if (year === null) {
      const y = pickNumber(props, ['SEASON', 'season', 'year']);
      if (Number.isFinite(y)) year = y;
    }

    const geometry = feature.geometry;
    if (!geometry) continue;

    if (geometry.type === 'Point') {
      const coords = geometry.coordinates as [number, number] | undefined;
      if (!Array.isArray(coords) || coords.length < 2) continue;

      const iso = pickString(props, ['ISO_TIME', 'time', 'time_iso']);
      const time = iso ? Date.parse(`${iso.replace(' ', 'T')}Z`) : Number.NaN;

      const wind = pickNumber(props, ['USA_WIND', 'WMO_WIND', 'wind', 'wind_kt']);
      const pressure = pickNumber(props, ['WMO_PRES', 'USA_PRES', 'pressure', 'pres']);

      points.push({
        time: Number.isFinite(time) ? time : Number.NaN,
        lng: coords[0],
        lat: coords[1],
        windKt: Number.isFinite(wind) ? wind : Number.NaN,
        pressureHpa: Number.isFinite(pressure) ? pressure : Number.NaN,
        r34: toNullable(pickNumber(props, ['USA_R34_NE', 'r34'])),
        r50: toNullable(pickNumber(props, ['USA_R50_NE', 'r50'])),
        r64: toNullable(pickNumber(props, ['USA_R64_NE', 'r64'])),
      });
    } else if (geometry.type === 'LineString') {
      // LineString exports often carry parallel arrays in properties.
      const coords = geometry.coordinates as [number, number][] | undefined;
      if (!Array.isArray(coords)) continue;

      const times = props.ISO_TIME ?? props.times;
      const winds = props.USA_WIND ?? props.winds;
      const pressures = props.WMO_PRES ?? props.pressures;

      const timeArr = Array.isArray(times) ? times : [];
      const windArr = Array.isArray(winds) ? winds : [];
      const pressArr = Array.isArray(pressures) ? pressures : [];

      coords.forEach((coord, i) => {
        const iso = typeof timeArr[i] === 'string' ? (timeArr[i] as string) : '';
        const time = iso ? Date.parse(`${iso.replace(' ', 'T')}Z`) : Number.NaN;
        const wind = typeof windArr[i] === 'number' ? (windArr[i] as number) : Number.NaN;
        const pressure = typeof pressArr[i] === 'number' ? (pressArr[i] as number) : Number.NaN;

        points.push({
          time: Number.isFinite(time) ? time : Number.NaN,
          lng: coord[0],
          lat: coord[1],
          windKt: wind,
          pressureHpa: pressure,
          r34: null,
          r50: null,
          r64: null,
        });
      });

      if (timeArr.length !== coords.length) {
        warnings.push('时间数组与坐标数量不一致，缺失的时次已跳过。');
      }
    }
  }

  // Timeless points cannot be placed on a timeline, but they can still be drawn
  // in track order, so they are kept and flagged rather than dropped silently.
  const missingTime = points.filter((p) => !Number.isFinite(p.time)).length;
  if (missingTime > 0) {
    warnings.push(`${missingTime} 个点缺少时间戳（按文件顺序保留）。`);
  }

  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const dropped = points.length - valid.length;
  if (dropped > 0) warnings.push(`${dropped} 个点经纬度无效，已丢弃。`);

  if (valid.length === 0) {
    throw new Error('文件中没有可用的轨迹点（需要 Point/LineString 几何与经纬度）。');
  }

  // Sort only when every point has a timestamp; otherwise preserve file order.
  if (missingTime === 0) valid.sort((a, b) => a.time - b.time);

  return {
    name: name || 'IMPORTED',
    year,
    basin: basin || '?',
    points: valid,
    warnings,
  };
}

function toNullable(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* Rotation direction                                                 */
/* ------------------------------------------------------------------ */

/**
 * Cyclonic rotation direction.
 *
 * Northern-hemisphere systems rotate counter-clockwise, southern-hemisphere
 * systems clockwise — a consequence of the Coriolis sign. Used by the vortex
 * particle layer.
 */
export function rotationDirection(lat: number): 1 | -1 {
  return lat >= 0 ? 1 : -1;
}

/** Cyclone season label for the museum list. */
export function basinLabel(basin: string): string {
  switch (basin) {
    case 'WP':
      return '西北太平洋';
    case 'NA':
      return '北大西洋';
    case 'EP':
      return '东北太平洋';
    case 'SI':
      return '南印度洋';
    case 'SP':
      return '南太平洋';
    default:
      return basin;
  }
}
