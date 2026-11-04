/**
 * Synthetic fallback field.
 *
 * Used only when upstream is unreachable or the daily budget is exhausted, so
 * the engine can still be inspected offline. The pattern is deliberately
 * weather-shaped — a meandering mid-latitude jet, trade easterlies, a
 * hemisphere-dependent Hadley overturning signature — but it is NOT a forecast.
 *
 * Everything produced here is flagged `synthetic: true` and surfaced in the HUD,
 * so it can never be mistaken for observed or modelled data.
 */

import type { RawLocationPayload, GridSpec } from '../core/types';
import { DEG2RAD } from '../core/geo';

export interface SyntheticOptions {
  grid: GridSpec;
  level: number | 'surface';
  /** Number of hourly steps to emit (aligned to `startMs`). */
  hours: number;
  startMs: number;
}

/**
 * A plausible global zonal wind profile.
 *
 * The jet is modelled as a Gaussian in latitude whose core sits near 35° in
 * winter-hemisphere terms, plus a stationary wavenumber-3 meander so the flow
 * has troughs and ridges rather than perfect bands. Trades blow easterly
 * between ~0–30°, and the polar vortex gives a weak westerly at high latitude.
 */
function zonalWind(lat: number, lng: number, hour: number): number {
  const absLat = Math.abs(lat);

  // Mid-latitude jet core.
  const jetCentre = 35 + 6 * Math.cos((lng + hour * 0.6) * DEG2RAD * 3);
  const jet = 34 * Math.exp(-(((lat - jetCentre) / 13) ** 2));

  // Meander: wavenumber 3 travelling slowly eastward.
  const meander = 1 + 0.34 * Math.sin(lng * DEG2RAD * 3 + hour * 0.02);

  // Trade easterlies near the equator.
  const trades = -8.5 * Math.exp(-((lat / 16) ** 2));

  // Polar easterlies at the top.
  const polar = -5 * Math.exp(-(((absLat - 82) / 9) ** 2));

  return jet * meander + trades + polar;
}

/** Meridional component: Hadley/Ferrel cell overturning plus wave tilt. */
function meridionalWind(lat: number, lng: number, hour: number): number {
  const latSq = (lat / 30) ** 2;
  // Rising near the equator, subsiding in the subtropics: poleward near surface.
  const hadley = 3.4 * Math.sin(lat * DEG2RAD * 2.2) * Math.exp(-latSq);

  // Trough/ridge tilt of the jet.
  const wave = 4.6 * Math.sin(lng * DEG2RAD * 3 + hour * 0.02 + 1.1) * Math.exp(-(((Math.abs(lat) - 40) / 22) ** 2));

  return hadley + wave;
}

/** Rough scalar fields per variable, tuned to look meteorologically sane. */
function scalarAt(
  variable: string,
  lat: number,
  lng: number,
  level: number | 'surface',
  hour: number,
  windSpeed: number,
): number {
  const pressure = level === 'surface' ? 1000 : level;

  // Standard-atmosphere temperature as a starting point.
  const altitude = 44330 * (1 - (pressure / 1013.25) ** 0.1903);
  const lapse = 15 - 6.5 * Math.min(altitude, 11000) / 1000;

  switch (variable) {
    case 'temperature':
    case 'temperature_2m': {
      const seasonal = -14 * Math.cos((lat + 12) * DEG2RAD * 2);
      const diurnal = 4.2 * Math.cos((lng + hour * 15) * DEG2RAD);
      return lapse + seasonal + diurnal * (level === 'surface' ? 1 : 0.3);
    }
    case 'relative_humidity':
    case 'relative_humidity_2m': {
      const itcz = 82 * Math.exp(-((lat / 13) ** 2));
      const ocean = 52 + 16 * Math.sin(lng * DEG2RAD * 2);
      return Math.max(4, Math.min(99, ocean + itcz - windSpeed * 0.45));
    }
    case 'cloud_cover': {
      const itcz = 78 * Math.exp(-((lat / 11) ** 2));
      const storm = 44 * Math.exp(-(((Math.abs(lat) - 48) / 16) ** 2));
      return Math.max(0, Math.min(100, itcz + storm));
    }
    case 'geopotential_height': {
      const base = 44330 * (1 - (pressure / 1013.25) ** 0.1903);
      const thermal = 26 * Math.cos((lat + 10) * DEG2RAD * 2);
      return base + thermal;
    }
    case 'wind_speed':
    default:
      return windSpeed;
  }
}

/**
 * Build a response shaped exactly like Open-Meteo's array-of-locations payload,
 * so the worker consumes it through the identical code path.
 */
export function synthesisePayload(options: SyntheticOptions): {
  payload: RawLocationPayload[];
  times: string[];
} {
  const { grid, level, hours, startMs } = options;
  const { cols, rows } = grid;

  const variables =
    level === 'surface'
      ? ['wind_speed_10m', 'wind_direction_10m', 'temperature_2m', 'relative_humidity_2m', 'cloud_cover']
      : [
          `wind_speed_${level}hPa`,
          `wind_direction_${level}hPa`,
          `temperature_${level}hPa`,
          `relative_humidity_${level}hPa`,
          `cloud_cover_${level}hPa`,
          `geopotential_height_${level}hPa`,
        ];

  const times: string[] = [];
  for (let h = 0; h < hours; h += 1) {
    const stamp = new Date(startMs + h * 3_600_000);
    times.push(stamp.toISOString().slice(0, 16));
  }

  const payload: RawLocationPayload[] = [];

  for (let r = 0; r < rows; r += 1) {
    const lat = rows === 1 ? 0 : -85 + (170 * r) / (rows - 1);

    for (let c = 0; c < cols; c += 1) {
      const lng = -180 + (360 * c) / cols;

      const hourly: RawLocationPayload['hourly'] = { time: times };
      for (const variable of variables) {
        hourly[variable] = [];
      }

      for (let h = 0; h < hours; h += 1) {
        const u = zonalWind(lat, lng, h);
        const v = meridionalWind(lat, lng, h);
        const speed = Math.hypot(u, v);
        // Meteorological direction: where the wind comes FROM.
        const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
        const directionDeg = (direction + 360) % 360;

        for (const variable of variables) {
          const series = hourly[variable] as (number | null)[];

          if (variable.startsWith('wind_speed')) {
            series.push(Number(speed.toFixed(2)));
          } else if (variable.startsWith('wind_direction')) {
            series.push(Number(directionDeg.toFixed(1)));
          } else {
            const key = variable.split('_').slice(0, -1).join('_').replace(/_(10m|2m)$/, '');
            series.push(
              Number(scalarAt(key, lat, lng, level, h, speed).toFixed(2)),
            );
          }
        }
      }

      payload.push({
        latitude: Number(lat.toFixed(2)),
        longitude: Number(lng.toFixed(2)),
        hourly,
      });
    }
  }

  return { payload, times };
}
