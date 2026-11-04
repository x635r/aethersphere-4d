/**
 * Weather grid worker.
 *
 * Turns Open-Meteo's per-location JSON into render-ready typed arrays:
 *  - derives u/v components from speed+direction,
 *  - assembles row-major grids,
 *  - fills gaps and produces a smooth, resampled field for the GPU.
 *
 * All heavy lifting happens here so the main thread never blocks on parsing a
 * multi-megabyte payload or running interpolation.
 */

import type {
  GridSpec,
  RawLocationPayload,
  SerialisedFieldSet,
  WorkerRequest,
  WorkerResponse,
} from '../core/types';
import type { ScalarFieldId } from '../core/levels';
import { DEG2RAD } from '../core/geo';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Replace NaN cells with the mean of their valid neighbours. Underground
 * pressure levels (e.g. 1000 hPa over Tibet) occasionally report null, and a
 * single hole in the field would otherwise punch a visible artifact through the
 * particle layer.
 */
function fillGaps(values: Float32Array, cols: number, rows: number): Float32Array {
  const out = Float32Array.from(values);
  const stride = cols;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * stride + c;
      if (Number.isFinite(out[i])) continue;

      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const v = out[rr * stride + cc];
          if (Number.isFinite(v)) {
            sum += v;
            n += 1;
          }
        }
      }

      out[i] = n > 0 ? sum / n : 0;
    }
  }

  return out;
}

/**
 * Two passes of a 1-2-1 separable blur, edge-clamped, separately across
 * longitude (wrapping) and latitude (clamped). Open-Meteo returns a coarse
 * lattice; without this the particle layer shows a visible diamond pattern.
 */
function smoothField(values: Float32Array, cols: number, rows: number, passes = 2): Float32Array {
  let src = values;

  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(src.length);
    for (let r = 0; r < rows; r += 1) {
      const base = r * cols;
      for (let c = 0; c < cols; c += 1) {
        const left = src[base + ((c - 1 + cols) % cols)];
        const centre = src[base + c];
        const right = src[base + ((c + 1) % cols)];
        horizontal[base + c] = left * 0.25 + centre * 0.5 + right * 0.25;
      }
    }

    const vertical = new Float32Array(src.length);
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const up = horizontal[Math.max(0, r - 1) * cols + c];
        const centre = horizontal[r * cols + c];
        const down = horizontal[Math.min(rows - 1, r + 1) * cols + c];
        vertical[r * cols + c] = up * 0.25 + centre * 0.5 + down * 0.25;
      }
    }

    src = vertical;
  }

  return src;
}

/* ------------------------------------------------------------------ */
/* Field construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve a variable key against one location's hourly block.
 *
 * Open-Meteo appends `_<model>` to every key when multiple models are
 * requested, so an exact match is tried first and a suffix match second. This
 * keeps the worker correct whether or not the caller pinned models.
 */
function resolveSeries(
  hourly: RawLocationPayload['hourly'] | undefined,
  key: string,
): (number | null)[] | string[] | null {
  if (!hourly) return null;

  const direct = hourly[key];
  if (Array.isArray(direct)) return direct;

  const prefixed = `${key}_`;
  for (const candidate of Object.keys(hourly)) {
    if (candidate.startsWith(prefixed)) {
      const series = hourly[candidate];
      if (Array.isArray(series)) return series;
    }
  }

  return null;
}

function readSeries(
  payload: RawLocationPayload[],
  key: string,
  index: number,
  grid: GridSpec,
): Float32Array {
  const out = new Float32Array(grid.cols * grid.rows);

  for (let i = 0; i < payload.length; i += 1) {
    const series = resolveSeries(payload[i]?.hourly, key);
    const value = Array.isArray(series) ? series[index] : null;
    out[i] = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
  }

  return out;
}

function variableName(prefix: string, level: number | 'surface'): string {
  if (level === 'surface') {
    const map: Record<string, string> = {
      wind_speed: 'wind_speed_10m',
      wind_direction: 'wind_direction_10m',
      temperature: 'temperature_2m',
      relative_humidity: 'relative_humidity_2m',
      cloud_cover: 'cloud_cover',
      geopotential_height: 'surface_pressure',
      vertical_velocity: 'vertical_velocity_10m',
    };
    return map[prefix] ?? `${prefix}_2m`;
  }
  return `${prefix}_${level}hPa`;
}

function scalarVariable(scalarId: ScalarFieldId, level: number | 'surface'): string {
  switch (scalarId) {
    case 'wind_speed':
      return variableName('wind_speed', level);
    case 'temperature':
      return variableName('temperature', level);
    case 'geopotential_height':
      return variableName('geopotential_height', level);
    case 'relative_humidity':
      return variableName('relative_humidity', level);
    case 'cloud_cover':
      return variableName('cloud_cover', level);
    case 'vertical_velocity':
      return variableName('vertical_velocity', level);
    default:
      return variableName('temperature', level);
  }
}

/**
 * Geopotential height for a surface request is surface pressure in hPa; convert
 * it into an approximate geometric altitude so the readout stays in metres.
 */
function surfacePressureToAltitude(pressureHpa: number): number {
  return 44330 * (1 - (pressureHpa / 1013.25) ** 0.1903);
}

function buildFieldSet(request: WorkerRequest): SerialisedFieldSet {
  const { grid, level, scalarId, payload, times, model } = request;
  const { cols, rows } = grid;

  const speedKey = variableName('wind_speed', level);
  const directionKey = variableName('wind_direction', level);
  const scalarKey = scalarVariable(scalarId, level);

  const scalarFrames: { time: number; values: Float32Array }[] = [];
  const windFrames: { time: number; u: Float32Array; v: Float32Array; speed: Float32Array }[] = [];
  const epochTimes: number[] = [];

  let globalMin = Number.POSITIVE_INFINITY;
  let globalMax = Number.NEGATIVE_INFINITY;
  const allSpeeds: number[] = [];

  for (let t = 0; t < times.length; t += 1) {
    const epoch = Date.parse(`${times[t]}Z`);
    epochTimes.push(Number.isFinite(epoch) ? epoch : Date.now());

    const speedRaw = readSeries(payload, speedKey, t, grid);
    const dirRaw = readSeries(payload, directionKey, t, grid);
    const scalarRaw = readSeries(payload, scalarKey, t, grid);

    // Derive components. Direction is where the wind comes FROM, so the
    // eastward component is -speed*sin(dir) and northward is -speed*cos(dir).
    const uRaw = new Float32Array(speedRaw.length);
    const vRaw = new Float32Array(speedRaw.length);
    for (let i = 0; i < speedRaw.length; i += 1) {
      const speed = speedRaw[i];
      const dir = dirRaw[i];
      if (!Number.isFinite(speed) || !Number.isFinite(dir)) {
        uRaw[i] = Number.NaN;
        vRaw[i] = Number.NaN;
        continue;
      }
      const rad = dir * DEG2RAD;
      uRaw[i] = -speed * Math.sin(rad);
      vRaw[i] = -speed * Math.cos(rad);
    }

    const u = smoothField(fillGaps(uRaw, cols, rows), cols, rows);
    const v = smoothField(fillGaps(vRaw, cols, rows), cols, rows);

    const speed = new Float32Array(u.length);
    for (let i = 0; i < u.length; i += 1) {
      const magnitude = Math.hypot(u[i], v[i]);
      speed[i] = magnitude;
      if (t === 0) allSpeeds.push(magnitude);
    }

    let scalar = smoothField(fillGaps(scalarRaw, cols, rows), cols, rows);

    if (scalarId === 'geopotential_height' && level === 'surface') {
      const converted = new Float32Array(scalar.length);
      for (let i = 0; i < scalar.length; i += 1) {
        converted[i] = surfacePressureToAltitude(scalar[i]);
      }
      scalar = converted;
    }

    if (t === 0) {
      for (let i = 0; i < scalar.length; i += 1) {
        const value = scalar[i];
        if (!Number.isFinite(value)) continue;
        if (value < globalMin) globalMin = value;
        if (value > globalMax) globalMax = value;
      }
    }

    scalarFrames.push({ time: epochTimes[t], values: scalar });
    windFrames.push({ time: epochTimes[t], u, v, speed });
  }

  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) {
    globalMin = 0;
    globalMax = 1;
  }
  if (globalMax - globalMin < 1e-6) {
    globalMax = globalMin + 1;
  }

  // 95th percentile keeps the jet stream from washing out the whole ramp.
  const sorted = allSpeeds.sort((a, b) => a - b);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const windReference = Math.max(1, sorted[p95Idx] ?? 1);


  return {
    level,
    scalarId,
    grid,
    times: epochTimes,
    scalar: scalarFrames,
    wind: windFrames,
    scalarRange: { min: globalMin, max: globalMax },
    windReference,
    model,
  };
}

/* ------------------------------------------------------------------ */
/* Message loop                                                        */
/* ------------------------------------------------------------------ */

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind !== 'build') {
    return;
  }

  try {
    const fieldSet = buildFieldSet(request);
    const transfer: Transferable[] = [];

    for (const frame of fieldSet.scalar) transfer.push(frame.values.buffer);
    for (const frame of fieldSet.wind) {
      transfer.push(frame.u.buffer, frame.v.buffer, frame.speed.buffer);
    }

    const response: WorkerResponse = { id: request.id, ok: true, fieldSet };
    ctx.postMessage(response, transfer);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};
