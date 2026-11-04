/**
 * Web-Mercator and spherical helpers.
 *
 * The mercator formulas here are byte-for-byte identical to MapLibre's internal
 * `mercatorXfromLng` / `mercatorYfromLat` so that geometry produced for a
 * custom layer lands on exactly the same pixel as the basemap.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Longitude in degrees to normalised web-mercator X in [0, 1]. */
export function mercatorXFromLng(lng: number): number {
  return (180 + lng) / 360;
}

/** Latitude in degrees to normalised web-mercator Y in [0, 1]. */
export function mercatorYFromLat(lat: number): number {
  return (
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) /
    360
  );
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
}

/** Wrap a longitude into [-180, 180). */
export function wrapLng(lng: number): number {
  let l = ((lng + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Convert a meteorological wind (speed, direction the wind comes FROM) into
 * eastward `u` and northward `v` components.
 *
 * Convention: direction is degrees clockwise from north, indicating where the
 * wind originates. A 270° wind blows from the west, so it travels east (+u).
 */
export function windToUV(speed: number, directionDeg: number): { u: number; v: number } {
  const rad = directionDeg * DEG2RAD;
  return {
    u: -speed * Math.sin(rad),
    v: -speed * Math.cos(rad),
  };
}

/** Inverse of windToUV: components to speed and meteorological direction. */
export function uvToWind(u: number, v: number): { speed: number; direction: number } {
  const speed = Math.hypot(u, v);
  if (speed < 1e-9) return { speed: 0, direction: 0 };
  const direction = (Math.atan2(-u, -v) * RAD2DEG + 360) % 360;
  return { speed, direction };
}

/** 16-point compass label for a meteorological direction. */
const COMPASS = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
] as const;

export function compassLabel(directionDeg: number): string {
  const idx = Math.round(((directionDeg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[idx];
}

export const COMPASS_ZH = [
  '北', '北东北', '东北', '东东北',
  '东', '东东南', '东南', '南东南',
  '南', '南西南', '西南', '西西南',
  '西', '西西北', '西北', '北西北',
] as const;

export function compassLabelZh(directionDeg: number): string {
  const idx = Math.round(((directionDeg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_ZH[idx];
}

export function normalizeLngDelta(delta: number): number {
  return ((delta + 540) % 360) - 180;
}
