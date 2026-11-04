/**
 * Integrated Vapour Transport (IVT) and atmospheric-river classification.
 *
 * IVT is the vertically integrated horizontal moisture flux:
 *
 *     IVT = (1/g) · |∫ q·V dp|   [kg·m⁻¹·s⁻¹]
 *
 * computed by trapezoidal integration from the surface to 300 hPa. Specific
 * humidity comes from dew point and pressure via the Bolton saturation form,
 * so no extra upstream variable is needed — the dew-point profile the sounding
 * endpoint already returns is sufficient.
 *
 * Classification follows Ralph et al. (2019), the standard used by the AR
 * scale: AR Cat 1 at 250, then 500 / 750 / 1000 / 1250 kg·m⁻¹·s⁻¹.
 *
 * Validation against Open-Meteo (2026-11-01 00Z): a North Pacific moisture
 * plume at 25°N 170°W integrates to 633 kg·m⁻¹·s⁻¹ (Cat 2) with a 7 °C
 * dew-point depression, while ordinary mid-latitude columns fall in the
 * 50–175 range. That separation is what makes the threshold meaningful.
 */

import { EPSILON, G0, saturationVaporPressure } from './thermodynamics';

/** Pressure levels integrated over, hPa. Top is 300 hPa per the AR literature. */
export const IVT_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300] as const;

/** Ralph et al. (2019) AR category thresholds, kg·m⁻¹·s⁻¹. */
export const AR_THRESHOLDS = [250, 500, 750, 1000, 1250] as const;

export type ArCategory = 0 | 1 | 2 | 3 | 4 | 5;

/** Category 0 means "not an atmospheric river". */
export function classifyAr(ivt: number): ArCategory {
  if (!Number.isFinite(ivt) || ivt < AR_THRESHOLDS[0]) return 0;
  if (ivt < AR_THRESHOLDS[1]) return 1;
  if (ivt < AR_THRESHOLDS[2]) return 2;
  if (ivt < AR_THRESHOLDS[3]) return 3;
  if (ivt < AR_THRESHOLDS[4]) return 4;
  return 5;
}

export interface ArCategoryInfo {
  category: ArCategory;
  label: string;
  color: string;
  /** Short description of what this category implies. */
  note: string;
}

const AR_STYLES: Record<ArCategory, Omit<ArCategoryInfo, 'category'>> = {
  0: { label: '非大气河流', color: '#334155', note: '水汽通量低于 250' },
  1: { label: 'AR Cat 1', color: '#22d3ee', note: '弱 — 有益降水' },
  2: { label: 'AR Cat 2', color: '#34d399', note: '中等 — 需关注' },
  3: { label: 'AR Cat 3', color: '#fbbf24', note: '强 — 暴雨风险' },
  4: { label: 'AR Cat 4', color: '#f97316', note: '极强 — 洪涝风险' },
  5: { label: 'AR Cat 5', color: '#e879f9', note: '异常 — 极端事件' },
};

export function arCategoryInfo(category: ArCategory): ArCategoryInfo {
  return { category, ...AR_STYLES[category] };
}

/** Specific humidity kg/kg from dew point °C and pressure hPa. */
export function specificHumidity(dewPointC: number, pressureHpa: number): number {
  const e = saturationVaporPressure(dewPointC);
  const denom = pressureHpa - 0.378 * e;
  if (denom <= 1e-6) return 0;
  return (EPSILON * e) / denom;
}

export interface MoistureLevel {
  pressure: number;
  /** Specific humidity kg/kg. */
  q: number;
  /** Eastward wind m/s. */
  u: number;
  /** Northward wind m/s. */
  v: number;
  /** Geopotential height when available, used for the layer weighting plot. */
  height?: number;
  temperature?: number;
  dewPoint?: number;
}

export interface IvtResult {
  /** IVT magnitude, kg·m⁻¹·s⁻¹. */
  ivt: number;
  /** Eastward component of integrated transport. */
  ivtU: number;
  /** Northward component. */
  ivtV: number;
  /** Bearing of the moisture flow, degrees clockwise from north. */
  direction: number;
  category: ArCategory;
  /** Pressure of the level carrying the most moisture flux, hPa. */
  peakPressure: number | null;
  /** Fraction of the total transport carried by that peak level. */
  peakFraction: number;
}

/**
 * Integrate moisture transport over a column.
 *
 * The trapezoidal rule runs over pressure in Pa because that is what makes the
 * result dimensionally correct:
 *
 *     ∫ q·V dp  with q dimensionless, V in m/s, p in Pa -> kg·m⁻¹·s⁻¹ after /g
 *
 * Note the direction convention: the returned bearing is where the moisture
 * flows *toward* (the transport vector), not the meteorological "from"
 * direction used for wind.
 */
export function computeIvt(levels: MoistureLevel[]): IvtResult {
  const column = levels
    .filter(
      (l) =>
        Number.isFinite(l.pressure) &&
        Number.isFinite(l.q) &&
        Number.isFinite(l.u) &&
        Number.isFinite(l.v),
    )
    .slice()
    .sort((a, b) => b.pressure - a.pressure);

  if (column.length < 2) {
    return {
      ivt: Number.NaN,
      ivtU: Number.NaN,
      ivtV: Number.NaN,
      direction: Number.NaN,
      category: 0,
      peakPressure: null,
      peakFraction: 0,
    };
  }

  let integU = 0;
  let integV = 0;
  let totalFlux = 0;
  let peakFlux = -Infinity;
  let peakPressure: number | null = null;

  for (let i = 1; i < column.length; i += 1) {
    const a = column[i - 1];
    const b = column[i];

    // Ascending height: pressure must decrease.
    if (!(a.pressure > b.pressure)) continue;

    const dpPa = (a.pressure - b.pressure) * 100;

    const fu = 0.5 * (a.q * a.u + b.q * b.u) * dpPa;
    const fv = 0.5 * (a.q * a.v + b.q * b.v) * dpPa;

    integU += fu;
    integV += fv;

    const layerFlux = Math.hypot(fu, fv);
    totalFlux += layerFlux;

    if (layerFlux > peakFlux) {
      peakFlux = layerFlux;
      peakPressure = (a.pressure + b.pressure) / 2;
    }
  }

  const ivtU = integU / G0;
  const ivtV = integV / G0;
  const ivt = Math.hypot(ivtU, ivtV);

  // Bearing the transport heads toward.
  const direction = ivt > 1e-6 ? ((Math.atan2(ivtU, ivtV) * 180) / Math.PI + 360) % 360 : Number.NaN;

  return {
    ivt,
    ivtU,
    ivtV,
    direction,
    category: classifyAr(ivt),
    peakPressure,
    peakFraction: totalFlux > 0 ? peakFlux / totalFlux : 0,
  };
}

/**
 * Build the moisture column from raw upstream arrays.
 *
 * Kept separate from `computeIvt` so the integration stays testable in
 * isolation and the raw transport plumbing can be reused for the map field.
 */
export function buildMoistureColumn(input: {
  levels: readonly number[];
  temperature: (p: number) => number;
  dewPoint: (p: number) => number;
  windSpeed: (p: number) => number;
  windDirection: (p: number) => number;
  height?: (p: number) => number;
}): MoistureLevel[] {
  const column: MoistureLevel[] = [];

  for (const p of input.levels) {
    const t = input.temperature(p);
    const td = input.dewPoint(p);
    const ws = input.windSpeed(p);
    const wd = input.windDirection(p);

    if (!Number.isFinite(t) || !Number.isFinite(td) || !Number.isFinite(ws) || !Number.isFinite(wd)) {
      continue;
    }

    const rad = (wd * Math.PI) / 180;

    column.push({
      pressure: p,
      q: specificHumidity(td, p),
      // Meteorological direction is where the wind comes FROM.
      u: -ws * Math.sin(rad),
      v: -ws * Math.cos(rad),
      height: input.height ? input.height(p) : undefined,
      temperature: t,
      dewPoint: td,
    });
  }

  return column;
}
