/**
 * Bilinear sampling of a weather field at an arbitrary lon/lat.
 *
 * Mirrors the GPU's texture filtering so the crosshair readout matches the
 * colour actually rendered under the cursor. Longitude wraps; latitude clamps.
 */

import type { WeatherFieldSet, VectorFrame, ScalarFrame } from '../core/types';

export interface FieldSample {
  u: number;
  v: number;
  speed: number;
  direction: number;
  scalar: number;
}

function wrapIndex(value: number, size: number): number {
  const m = value % size;
  return m < 0 ? m + size : m;
}

function clampIndex(value: number, size: number): number {
  return value < 0 ? 0 : value > size - 1 ? size - 1 : value;
}

function bilinear(
  data: Float32Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const c0 = wrapIndex(x0, cols);
  const c1 = wrapIndex(x0 + 1, cols);
  const r0 = clampIndex(y0, rows);
  const r1 = clampIndex(y0 + 1, rows);

  const v00 = data[r0 * cols + c0];
  const v10 = data[r0 * cols + c1];
  const v01 = data[r1 * cols + c0];
  const v11 = data[r1 * cols + c1];

  if (
    !Number.isFinite(v00) ||
    !Number.isFinite(v10) ||
    !Number.isFinite(v01) ||
    !Number.isFinite(v11)
  ) {
    const fallback = [v00, v10, v01, v11].filter(Number.isFinite);
    return fallback.length ? fallback.reduce((a, b) => a + b, 0) / fallback.length : Number.NaN;
  }

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/** Convert lon/lat into fractional grid coordinates for the stored lattice. */
export function gridCoords(
  lng: number,
  lat: number,
  cols: number,
  rows: number,
): { x: number; y: number } {
  const x = ((lng + 180) / 360) * cols;
  const y = rows === 1 ? 0 : ((lat + 85) / 170) * (rows - 1);
  return { x, y };
}

export function sampleVector(
  frame: VectorFrame,
  cols: number,
  rows: number,
  lng: number,
  lat: number,
): { u: number; v: number; speed: number } {
  const { x, y } = gridCoords(lng, lat, cols, rows);

  // Grid columns start at the -180 meridian; +0.5 aligns to sample centres.
  const u = bilinear(frame.u, cols, rows, x - 0.5, y);
  const v = bilinear(frame.v, cols, rows, x - 0.5, y);

  return { u, v, speed: Math.hypot(u, v) };
}

export function sampleScalar(
  frame: ScalarFrame,
  cols: number,
  rows: number,
  lng: number,
  lat: number,
): number {
  const { x, y } = gridCoords(lng, lat, cols, rows);
  return bilinear(frame.values, cols, rows, x - 0.5, y);
}

/**
 * Sample a whole field at a location and time index. The time index is clamped,
 * so scrubbing past the end of the loaded window degrades gracefully.
 */
export function sampleField(
  fieldSet: WeatherFieldSet,
  lng: number,
  lat: number,
  timeIndex: number,
): FieldSample | null {
  const { cols, rows } = fieldSet.grid;
  const idx = Math.max(0, Math.min(fieldSet.times.length - 1, Math.round(timeIndex)));

  const windFrame = fieldSet.wind[idx];
  const scalarFrame = fieldSet.scalar[idx];
  if (!windFrame) return null;

  const { u, v, speed } = sampleVector(windFrame, cols, rows, lng, lat);
  const scalar = scalarFrame
    ? sampleScalar(scalarFrame, cols, rows, lng, lat)
    : Number.NaN;

  if (!Number.isFinite(speed) || !Number.isFinite(scalar)) {
    return null;
  }

  // Meteorological direction the wind comes FROM.
  const direction = speed < 1e-6 ? 0 : (Math.atan2(-u, -v) * 180) / Math.PI;
  const normalised = (direction + 360) % 360;

  return { u, v, speed, direction: normalised, scalar };
}
