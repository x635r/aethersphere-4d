/**
 * Solar position maths for the day/night terminator.
 *
 * The terminator is the great circle 90° from the subsolar point, so it is fully
 * determined by that point's latitude (declination) and longitude. Both are
 * derived here from the UTC timestamp with the NOAA solar-position algorithm
 * (low-precision variant: well under 0.02° over 1950–2050, i.e. sub-pixel).
 */

import { DEG2RAD, RAD2DEG } from './geo';

export interface SubsolarPoint {
  /** Declination of the sun in degrees, +N. */
  declination: number;
  /** Longitude where the sun is directly overhead, in [-180, 180). */
  longitude: number;
  /** Greenwich hour angle of the sun in degrees, 0..360. */
  hourAngle: number;
}

/** Unix epoch (1970-01-01T00:00Z) in Julian days. */
const JD_UNIX_EPOCH = 2440587.5;

export function julianDay(epochMs: number): number {
  return epochMs / 86_400_000 + JD_UNIX_EPOCH;
}

/**
 * Subsolar point for an instant.
 *
 * Chain: Julian century -> mean longitude & anomaly -> equation of centre ->
 * apparent longitude -> obliquity -> declination, plus the equation of time for
 * the longitude offset.
 */
export function subsolarPoint(epochMs: number): SubsolarPoint {
  const jd = julianDay(epochMs);
  const T = (jd - 2451545.0) / 36525.0;

  // Geometric mean longitude of the sun, degrees.
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;

  // Geometric mean anomaly, degrees.
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const Mrad = M * DEG2RAD;

  // Equation of centre, degrees.
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;

  // Apparent longitude of the sun, corrected for nutation and aberration.
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG2RAD);

  // Mean obliquity of the ecliptic, corrected, degrees.
  const epsilon0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const epsilon = epsilon0 + 0.00256 * Math.cos(omega * DEG2RAD);

  // Declination, degrees.
  const declination =
    Math.asin(Math.sin(epsilon * DEG2RAD) * Math.sin(lambda * DEG2RAD)) * RAD2DEG;

  // Equation of time, minutes.
  const y = Math.tan((epsilon / 2) * DEG2RAD) ** 2;
  const e = 0.016708634;
  const eqTime =
    4 *
    RAD2DEG *
    (y * Math.sin(2 * L0 * DEG2RAD) -
      2 * e * Math.sin(Mrad) +
      4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0 * DEG2RAD) -
      0.5 * y * y * Math.sin(4 * L0 * DEG2RAD) -
      1.25 * e * e * Math.sin(2 * Mrad));

  // Solar noon is at 720 - eqTime minutes UTC; longitude uses 4 min per degree.
  const date = new Date(epochMs);
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;

  const hourAngle = ((utcMinutes - 720 + eqTime) / 4 + 360) % 360;
  const longitude = -((utcMinutes - 720 + eqTime) / 4);

  return {
    declination,
    longitude: ((longitude + 540) % 360) - 180,
    hourAngle,
  };
}

/** Solar elevation in degrees at a location. Positive means daylight. */
export function solarElevation(lat: number, lng: number, sub: SubsolarPoint): number {
  const latRad = lat * DEG2RAD;
  const decRad = sub.declination * DEG2RAD;
  const hourAngleRad = (lng - sub.longitude) * DEG2RAD;

  const sinElev =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngleRad);

  return Math.asin(Math.max(-1, Math.min(1, sinElev))) * RAD2DEG;
}

/** Solar azimuth in degrees clockwise from north. */
export function solarAzimuth(lat: number, lng: number, sub: SubsolarPoint): number {
  const latRad = lat * DEG2RAD;
  const decRad = sub.declination * DEG2RAD;
  const hourAngleRad = (lng - sub.longitude) * DEG2RAD;

  const cosZenith =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngleRad);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));

  const denom = Math.sin(zenith) * Math.cos(latRad);
  if (Math.abs(denom) < 1e-9) return 0;

  const cosAz =
    (Math.sin(decRad) - Math.sin(latRad) * Math.cos(zenith)) / denom;
  const az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD2DEG;
  // Mirror for afternoon (hour angle westward of the sun).
  return hourAngleRad > 0 ? (360 - az) % 360 : az;
}

/**
 * Latitude at which the terminator sits for a given hour angle, from the
 * closed-form solution of  sin(lat)sin(dec) + cos(lat)cos(dec)cos(H) = 0:
 *
 *     tan(lat) = -cos(H) / tan(dec)
 *
 * This is the exact inverse, so the sampled ring has zero elevation error.
 */
export function terminatorLatitude(hourAngleDeg: number, declinationDeg: number): number {
  const denom = Math.tan(declinationDeg * DEG2RAD);
  const numerator = -Math.cos(hourAngleDeg * DEG2RAD);

  if (Math.abs(denom) < 1e-9) {
    // Equinox: the terminator runs along a meridian pair, poles are the extremes.
    return numerator < 0 ? 90 : -90;
  }

  return Math.atan(numerator / denom) * RAD2DEG;
}

/**
 * Night-side polygon in [lng, lat] pairs: the terminator swept pole to pole and
 * closed through the pole currently in permanent darkness.
 *
 * Note this is only used for a coarse overlay; the shader-based day/night mask
 * is what actually renders, because polygon fills distort on the globe.
 */
export function nightPolygon(
  sub: SubsolarPoint,
  samples = 512,
): [number, number][] {
  const ring: [number, number][] = [];

  for (let i = 0; i <= samples; i += 1) {
    const hourAngle = -180 + (i / samples) * 360;
    const lat = terminatorLatitude(hourAngle, sub.declination);
    const lng = ((sub.longitude + hourAngle + 540) % 360) - 180;
    ring.push([lng, Math.max(-89.999, Math.min(89.999, lat))]);
  }

  const nightPoleLat = sub.declination > 0 ? -90 : 90;
  const firstLng = ring[0][0];
  const lastLng = ring[ring.length - 1][0];

  return [...ring, [lastLng, nightPoleLat], [firstLng, nightPoleLat]];
}
