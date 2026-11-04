import type { ScalarFieldId } from './levels';

/** A grid of sample points covering the globe in a regular lon/lat lattice. */
export interface GridSpec {
  /** Number of columns (longitude samples), evenly spaced, starting at -180. */
  cols: number;
  /** Number of rows (latitude samples), evenly spaced, from -85 to +85. */
  rows: number;
}

/** One hourly (or 3-hourly) step of a scalar field on the grid. */
export interface ScalarFrame {
  /** UTC epoch milliseconds of this step. */
  time: number;
  /** Row-major [rows * cols] values; NaN marks a missing sample. */
  values: Float32Array;
}

/** One step of the vector wind field: eastward (u) and northward (v) components. */
export interface VectorFrame {
  time: number;
  /** Eastward component in m/s, row-major [rows * cols]. */
  u: Float32Array;
  /** Northward component in m/s, row-major [rows * cols]. */
  v: Float32Array;
  /** Wind speed magnitude in m/s, precomputed for colouring and probing. */
  speed: Float32Array;
}

/** A complete, ready-to-render dataset for one level and one scalar field. */
export interface WeatherFieldSet {
  level: number | 'surface';
  scalarId: ScalarFieldId;
  grid: GridSpec;
  times: number[];
  scalar: ScalarFrame[];
  wind: VectorFrame[];
  /** Min/max across all scalar frames, used to normalise the colour ramp. */
  scalarRange: { min: number; max: number };
  /** P95 wind speed, used as the velocity normalisation reference. */
  windReference: number;
  /** Which upstream model produced this data. */
  model: string;
}

/** A point sample used by the crosshair probe and the readout panel. */
export interface ProbeSample {
  lng: number;
  lat: number;
  windSpeed: number;
  windDirection: number;
  u: number;
  v: number;
  scalarValue: number;
  scalarId: ScalarFieldId;
  level: number | 'surface';
  time: number;
}

export interface GridRequest {
  grid: GridSpec;
  level: number | 'surface';
  scalarId: ScalarFieldId;
  timeIndex?: number;
  models?: string;
  signal?: AbortSignal;
}

export interface WorkerRequest {
  id: number;
  kind: 'build';
  grid: GridSpec;
  level: number | 'surface';
  scalarId: ScalarFieldId;
  times: string[];
  payload: RawLocationPayload[];
  model: string;
}

/**
 * Shape of one element of Open-Meteo's array response for multiple coordinates.
 *
 * `hourly.time` is an array of strings, while every other key holds numbers
 * (or null over regions where a level does not exist).
 */
export interface RawLocationPayload {
  latitude: number;
  longitude: number;
  elevation?: number;
  hourly: {
    time: string[];
    [variable: string]: (number | null)[] | string[];
  };
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  fieldSet?: SerialisedFieldSet;
  error?: string;
}

/** Transferable form of WeatherFieldSet (typed arrays can be transferred). */
export interface SerialisedFieldSet {
  level: number | 'surface';
  scalarId: ScalarFieldId;
  grid: GridSpec;
  times: number[];
  scalar: { time: number; values: Float32Array }[];
  wind: { time: number; u: Float32Array; v: Float32Array; speed: Float32Array }[];
  scalarRange: { min: number; max: number };
  windReference: number;
  model: string;
}
