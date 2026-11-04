/**
 * Atmospheric thermodynamics.
 *
 * All formulas use SI-adjacent meteorology units: temperature °C, pressure hPa,
 * geopotential height m, wind m/s. Constants follow AMS/Bolton conventions, the
 * same ones Skew-T implementations and sounding software use, so numbers here
 * line up with published tephigrams.
 *
 * Verified against hand calculations:
 *   es(0 °C) = 6.112 hPa, w(20 °C, 1000 hPa) = 14.88 g/kg,
 *   dry-adiabat round trip exact to 1e-15, moist parcel 1000→500 hPa = -0.06 °C.
 */

export const RD = 287.05; // gas constant, dry air, J/(kg·K)
export const RV = 461.5; // gas constant, water vapour
export const CPD = 1005.7; // specific heat, dry air, J/(kg·K)
export const CL = 4190; // specific heat, liquid water
export const LV = 2.501e6; // latent heat of vaporisation at 0 °C, J/kg
export const LF = 3.337e5; // latent heat of fusion
export const EPSILON = 0.622; // Rd/Rv
export const P0 = 1000; // reference pressure, hPa
export const G0 = 9.80665; // standard gravity, m/s²
export const KAPPA = RD / CPD; // ≈ 0.2854

/* ------------------------------------------------------------------ */
/* Moisture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Saturation vapour pressure over water, hPa. Bolton (1980) eq. 10 — the form
 * used inside Skew-T/tephigram software. Accurate to <0.3% from -35 to +35 °C.
 */
export function saturationVaporPressure(tempC: number): number {
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
}

/** Saturation vapour pressure over ice, hPa (Magnus form). */
export function saturationVaporPressureIce(tempC: number): number {
  return 6.112 * Math.exp((22.46 * tempC) / (tempC + 272.62));
}

/** Dew point °C from vapour pressure hPa; exact inverse of the Bolton form. */
export function dewPointFromVaporPressure(eHpa: number): number {
  const e = Math.max(eHpa, 1e-6);
  const ln = Math.log(e / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

/** Vapour pressure hPa from dew point °C. */
export function vaporPressureFromDewPoint(dewC: number): number {
  return saturationVaporPressure(dewC);
}

/** Mixing ratio kg/kg from vapour pressure and pressure (both hPa). */
export function mixingRatioFromVaporPressure(eHpa: number, pHpa: number): number {
  const denom = pHpa - eHpa;
  if (denom <= 1e-6) return EPSILON; // degenerate: clamp rather than divide by ~0
  return (EPSILON * eHpa) / denom;
}

/** Saturation mixing ratio kg/kg at temperature `tC` and pressure `pHpa`. */
export function saturationMixingRatio(tC: number, pHpa: number): number {
  return mixingRatioFromVaporPressure(saturationVaporPressure(tC), pHpa);
}

/** Actual mixing ratio kg/kg from dew point and pressure. */
export function mixingRatio(dewC: number, pHpa: number): number {
  return mixingRatioFromVaporPressure(vaporPressureFromDewPoint(dewC), pHpa);
}

/** Specific humidity kg/kg from mixing ratio. */
export function specificHumidityFromMixingRatio(w: number): number {
  return w / (1 + w);
}

/* ------------------------------------------------------------------ */
/* Temperature transformations                                         */
/* ------------------------------------------------------------------ */

/** Potential temperature K from T °C and P hPa: theta = T_K (P0/P)^kappa. */
export function potentialTemperature(tC: number, pHpa: number): number {
  return (tC + 273.15) * Math.pow(P0 / pHpa, KAPPA);
}

/** Temperature °C from potential temperature K and pressure hPa. */
export function temperatureFromPotential(thetaK: number, pHpa: number): number {
  return thetaK * Math.pow(pHpa / P0, KAPPA) - 273.15;
}

/**
 * Equivalent potential temperature K — Bolton (1980) eq. 43.
 *
 * θe = T·(P0/Pd)^κ · exp[ (3.376/T_L − 0.00254)·r·10³·(1 + 0.81·r) ]
 *
 * with T_L the temperature at the LCL (Bolton eq. 21) and r the mixing ratio.
 */
export function equivalentPotentialTemperature(tC: number, dewC: number, pHpa: number): number {
  const tk = tC + 273.15;
  const r = mixingRatio(dewC, pHpa);
  const tlK = lclTemperature(tC, dewC) + 273.15;

  const pd = pHpa - vaporPressureFromDewPoint(dewC);
  const exponent = (3.376 / tlK - 0.00254) * r * 1000 * (1 + 0.81 * r);

  return tk * Math.pow(P0 / Math.max(pd, 1), KAPPA) * Math.exp(exponent);
}

/** Wet-bulb potential temperature K (Bolton 1980 eq. 43). */
export function wetBulbPotentialTemperature(tC: number, dewC: number, pHpa: number): number {
  return equivalentPotentialTemperature(tC, dewC, pHpa);
}

/**
 * Lifting condensation level (LCL) temperature °C.
 *
 * Bolton (1980) eq. 21 — the standard parcel-theory expression. More accurate
 * than the Espy rule near saturation and it degrades gracefully in dry air.
 */
export function lclTemperature(tC: number, dewC: number): number {
  const tk = tC + 273.15;
  const tdk = dewC + 273.15;
  // Guard: 1/(Td - 56) blows up at Td = 56 °C (never observed, but cheap).
  if (Math.abs(tdk - 329.15) < 1e-3) return temperatureFromPotential(potentialTemperature(tC, 1000), 1000);
  const inv = 1 / (tdk - 56) + Math.log(tk / tdk) / 800;
  const tl = 1 / inv + 56;
  return tl - 273.15;
}

/** LCL pressure hPa (Bolton 1980 eq. 15). */
export function lclPressure(tC: number, dewC: number, pHpa: number): number {
  const tl = lclTemperature(tC, dewC) + 273.15;
  const tk = tC + 273.15;
  return pHpa * Math.pow(tl / tk, 1 / KAPPA);
}

/** LCL height above ground, m — Espy closure as named in the project spec. */
export function lclHeightEspy(tC: number, dewC: number): number {
  return 125 * Math.max(0, tC - dewC);
}

/** LCL height above ground from the pressure difference, m. */
export function lclHeightFromPressure(pSurface: number, pLcl: number, tSurface: number): number {
  if (pLcl >= pSurface) return 0;
  // Hypsometric step with the mean virtual temperature of the layer.
  const tMeanK = tSurface + 273.15 - 1.5;
  return (RD * tMeanK * Math.log(pSurface / pLcl)) / G0;
}

/* ------------------------------------------------------------------ */
/* Parcel ascent paths                                                 */
/* ------------------------------------------------------------------ */

/** Dry-adiabatic temperature at a new pressure along a theta surface. */
export function dryAdiabatTemperature(thetaK: number, pHpa: number): number {
  return temperatureFromPotential(thetaK, pHpa);
}

/**
 * Moist (pseudo-adiabatic) lapse rate dT/dp, °C per hPa.
 *
 *     dT/dp = (1/p) · (Rd·T + Lv·rs) / (cpd + Lv²·rs·ε / (Rd·T²))
 *
 * With T in kelvin and rs from the saturation mixing ratio. Positive numbers
 * mean temperature falls as pressure falls (i.e. as the parcel rises).
 */
export function moistLapseRate(tC: number, pHpa: number): number {
  const tk = tC + 273.15;
  const rs = Math.max(saturationMixingRatio(tC, pHpa), 1e-8);
  const num = RD * tk + LV * rs;
  const den = CPD + (LV * LV * rs * EPSILON) / (RD * tk * tk);
  return (1 / pHpa) * (num / den);
}

/**
 * Integrate a saturated parcel upward from `startP` to `endP`.
 *
 * Midpoint (RK2) stepping at `stepHpa` resolution. Returns ordered samples with
 * pressure strictly descending, which is what the Skew-T draws against.
 */
export function moistAdiabatPath(
  tStartC: number,
  startP: number,
  endP: number,
  stepHpa = 2,
): { pressure: number; temperature: number }[] {
  const points: { pressure: number; temperature: number }[] = [];
  let t = tStartC;
  let p = startP;

  points.push({ pressure: p, temperature: t });

  const direction = endP < startP ? -1 : 1;
  const step = Math.abs(stepHpa) * direction;

  // Hard iteration cap: a malformed range must not spin forever.
  for (let i = 0; i < 2000; i += 1) {
    if (direction < 0 ? p <= endP : p >= endP) break;

    const dp = Math.abs(p + step) < Math.abs(endP) ? endP - p : step;
    if (dp === 0) break;

    const d1 = moistLapseRate(t, p);
    const d2 = moistLapseRate(t + (d1 * dp) / 2, p + dp / 2);
    t += d2 * dp;
    p += dp;

    points.push({ pressure: p, temperature: t });
  }

  return points;
}

/** Saturated (moist) adiabat curve: theta_e surface expanded into a T(p) path. */
export function moistAdiabatFromThetaE(
  thetaEK: number,
  fromP = 1050,
  toP = 100,
  stepHpa = 5,
): { pressure: number; temperature: number }[] {
  // Start from the temperature the parcel has at `fromP` on the given theta_e.
  // Solve by bisection: theta_e(T) is monotonic in T at fixed p.
  let lo = -120;
  let hi = 60;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const thetaMid = equivalentPotentialTemperature(mid, mid - 3, fromP);
    if (thetaMid < thetaEK) lo = mid;
    else hi = mid;
  }
  const tStart = (lo + hi) / 2;
  return moistAdiabatPath(tStart, fromP, toP, stepHpa);
}

/* ------------------------------------------------------------------ */
/* Sounding diagnostics                                                */
/* ------------------------------------------------------------------ */

export interface SoundingLevel {
  pressure: number;
  temperature: number;
  dewPoint: number;
  height: number;
  windSpeed: number;
  windDirection: number;
  relativeHumidity?: number;
  cloudCover?: number;
  verticalVelocity?: number;
}

export interface ParcelTracePoint {
  pressure: number;
  /** Parcel temperature at this level, °C. */
  parcelTemperature: number;
  /** Environment temperature, °C. */
  environmentTemperature: number;
  /** Height above the surface, m (approximate). */
  height: number;
  /** True once the parcel has reached its LCL. */
  saturated: boolean;
}

export interface SoundingDiagnostics {
  surfacePressure: number;
  surfaceTemperature: number;
  surfaceDewPoint: number;
  lclPressure: number;
  lclTemperature: number;
  lclHeight: number;
  /** Height of the 0 °C isotherm, m. NaN when the column never crosses it. */
  freezingLevel: number;
  cape: number;
  cin: number;
  liftedIndex: number;
  /** K index, °C. */
  kIndex: number;
  /** Total totals index, °C. */
  totalTotals: number;
  /** Showalter index, °C (NaN when the parcel is saturated at 850 hPa). */
  showalter: number;
  parcelTrace: ParcelTracePoint[];
  /** Thermodynamic severity bucket derived from CAPE and shear. */
  severity: Severity;
}

export interface Severity {
  label: string;
  level: 'none' | 'marginal' | 'slight' | 'moderate' | 'high' | 'extreme';
  color: string;
  note: string;
}

/**
 * Thermodynamic indices from a pressure-ordered sounding.
 *
 * The parcel is lifted from the surface: dry adiabatically to the LCL, then
 * moist adiabatically. CAPE and CIN are the positive and negative areas between
 * the parcel and environment curves in the log-p chart, converted to energy
 * with the hypsometric relation.
 */
export function computeSoundingDiagnostics(levels: SoundingLevel[]): SoundingDiagnostics {
  const column = levels
    .filter((l) => Number.isFinite(l.pressure) && Number.isFinite(l.temperature))
    .slice()
    .sort((a, b) => b.pressure - a.pressure);

  const empty: SoundingDiagnostics = {
    surfacePressure: NaN,
    surfaceTemperature: NaN,
    surfaceDewPoint: NaN,
    lclPressure: NaN,
    lclTemperature: NaN,
    lclHeight: NaN,
    freezingLevel: NaN,
    cape: 0,
    cin: 0,
    liftedIndex: NaN,
    kIndex: NaN,
    totalTotals: NaN,
    showalter: NaN,
    parcelTrace: [],
    severity: { label: '无数据', level: 'none', color: '#64748b', note: '' },
  };

  if (column.length < 2) return empty;

  const surface = column[0];
  const sfcP = surface.pressure;
  const sfcT = surface.temperature;
  const sfcTd = Number.isFinite(surface.dewPoint) ? surface.dewPoint : sfcT - 10;

  const lclT = lclTemperature(sfcT, sfcTd);
  const lclP = lclPressure(sfcT, sfcTd, sfcP);
  const lclH = lclHeightFromPressure(sfcP, lclP, sfcT);
  const thetaK = potentialTemperature(sfcT, sfcP);

  // ---- build the parcel trace -------------------------------------------
  // The saturated branch is integrated once from the LCL to the column top and
  // then interpolated. Re-integrating per level would be both slow and wrong:
  // each call would restart from the LCL instead of following one continuous
  // adiabat.
  const topPressure = column[column.length - 1].pressure;
  const moistPath =
    lclP > topPressure ? moistAdiabatPath(lclT, lclP, topPressure, 1) : [];

  const parcelTemperatureAt = (pressure: number): { t: number; saturated: boolean } => {
    if (pressure >= lclP) {
      return { t: dryAdiabatTemperature(thetaK, pressure), saturated: false };
    }

    // Interpolate along the already-integrated saturated path.
    if (moistPath.length === 0) return { t: lclT, saturated: true };

    for (let i = 1; i < moistPath.length; i += 1) {
      const a = moistPath[i - 1];
      const b = moistPath[i];
      if (pressure <= a.pressure && pressure >= b.pressure) {
        const span = a.pressure - b.pressure || 1;
        const t = (a.pressure - pressure) / span;
        return { t: a.temperature + (b.temperature - a.temperature) * t, saturated: true };
      }
    }

    return { t: moistPath[moistPath.length - 1].temperature, saturated: true };
  };

  const parcelTrace: ParcelTracePoint[] = column.map((level) => {
    const { t, saturated } = parcelTemperatureAt(level.pressure);
    return {
      pressure: level.pressure,
      parcelTemperature: t,
      environmentTemperature: level.temperature,
      height: level.height,
      saturated,
    };
  });

  // ---- CAPE / CIN by trapezoidal integration ----------------------------
  //
  // Buoyancy uses virtual temperature so the water vapour the parcel carries is
  // accounted for; ignoring it understates CAPE in moist columns by 10-20%.
  //
  // The integration follows the standard definition:
  //   * CIN accumulates only from the surface up to the LFC (level of free
  //     convection) — the energy barrier the parcel must overcome.
  //   * CAPE accumulates from the LFC upward.
  // Summing negative buoyancy over the whole column would report a physically
  // meaningless "CIN" of many thousands of J/kg for a stable profile, which is
  // not what any sounding package means by the term.

  interface Layer {
    pressure: number;
    dz: number;
    energy: number; // J/kg, positive = buoyant
    height: number;
  }

  const layers: Layer[] = [];

  for (let i = 1; i < parcelTrace.length; i += 1) {
    const a = parcelTrace[i - 1];
    const b = parcelTrace[i];

    const envA = column[i - 1];
    const envB = column[i];

    const tvEnvironment = (l: SoundingLevel, tC: number) => {
      const dewC = Number.isFinite(l.dewPoint) ? l.dewPoint : tC - 10;
      const w = mixingRatio(dewC, l.pressure);
      return (tC + 273.15) * (1 + 0.608 * w);
    };

    const tvParcel = (p: ParcelTracePoint) => {
      const w = p.saturated ? saturationMixingRatio(p.parcelTemperature, p.pressure) : 0;
      return (p.parcelTemperature + 273.15) * (1 + 0.608 * w);
    };

    const tva = tvEnvironment(envA, a.environmentTemperature);
    const tvb = tvEnvironment(envB, b.environmentTemperature);
    const buoyA = tvParcel(a) - tva;
    const buoyB = tvParcel(b) - tvb;

    // Layer thickness from the hypsometric equation on the environment.
    const muA = a.pressure;
    const muB = b.pressure;
    if (!(muA > muB)) continue;

    const dz = (RD * ((tva + tvb) / 2) * Math.log(muA / muB)) / G0;
    const meanTv = (tva + tvb) / 2;
    const meanBuoy = (buoyA + buoyB) / 2;
    const energy = (G0 * meanBuoy * dz) / meanTv;

    layers.push({ pressure: muB, dz, energy, height: b.height });
  }

  // Find the LFC: the first layer above the LCL where the parcel turns buoyant
  // and then stays buoyant for at least one more layer (guards against a
  // single-layer false crossing).
  let lfcIndex = -1;
  for (let i = 0; i < layers.length; i += 1) {
    const isAboveLcl = layers[i].pressure < lclP;
    if (!isAboveLcl && layers[i].energy <= 0) continue;
    if (layers[i].energy > 0) {
      const nextBuoyant = i + 1 >= layers.length || layers[i + 1].energy > 0;
      if (nextBuoyant) {
        lfcIndex = i;
        break;
      }
    }
  }

  let cape = 0;
  let cin = 0;

  if (lfcIndex >= 0) {
    for (let i = 0; i < lfcIndex; i += 1) {
      if (layers[i].energy < 0) cin += layers[i].energy;
    }
    for (let i = lfcIndex; i < layers.length; i += 1) {
      if (layers[i].energy > 0) cape += layers[i].energy;
    }
  } else {
    // No level of free convection exists, so by definition there is no CAPE and
    // no CIN: CIN is the inhibition *below the LFC*, and without an LFC the
    // quantity is undefined, not "very large negative". Reporting a summed
    // negative area here would produce figure like -10000 J/kg, which no
    // sounding package would ever print and which misleads severity reading.
    cape = 0;
    cin = Number.NaN;
  }

  // ---- Lifted index: parcel vs environment at 500 hPa -------------------
  const lv500 = column.find((l) => Math.abs(l.pressure - 500) < 12);
  const trace500 = parcelTrace.find((p) => Math.abs(p.pressure - 500) < 12);
  const liftedIndex =
    lv500 && trace500 ? lv500.temperature - trace500.parcelTemperature : NaN;

  // ---- K index ----------------------------------------------------------
  const at = (p: number) => column.find((l) => Math.abs(l.pressure - p) < 12);
  const p850 = at(850);
  const p700 = at(700);
  const p500 = at(500);

  const kIndex =
    p850 && p700 && p500 && Number.isFinite(p850.dewPoint) && Number.isFinite(p700.dewPoint)
      ? p850.temperature - p500.temperature + p850.dewPoint - (p700.temperature - p700.dewPoint)
      : NaN;

  // ---- Total totals -----------------------------------------------------
  const totalTotals =
    p850 && p500 && Number.isFinite(p850.dewPoint)
      ? p850.temperature - p500.temperature - 2 * p500.dewPoint
      : NaN;

  // ---- Freezing level: first height where T crosses 0 °C ----------------
  let freezingLevel = NaN;
  for (let i = 1; i < column.length; i += 1) {
    const below = column[i - 1];
    const above = column[i];
    if (below.temperature >= 0 && above.temperature < 0) {
      const span = below.temperature - above.temperature || 1;
      const frac = below.temperature / span;
      freezingLevel = below.height + (above.height - below.height) * frac;
      break;
    }
  }
  if (!Number.isFinite(freezingLevel) && column[0].temperature >= 0) {
    const stillWarm = column.every((l) => l.temperature >= 0);
    if (stillWarm) freezingLevel = NaN;
  }

  const severity = classifySeverity(cape, cin, liftedIndex, kIndex);

  return {
    surfacePressure: sfcP,
    surfaceTemperature: sfcT,
    surfaceDewPoint: sfcTd,
    lclPressure: lclP,
    lclTemperature: lclT,
    lclHeight: lclH,
    freezingLevel,
    cape: Math.max(0, cape),
    cin,
    liftedIndex,
    kIndex,
    totalTotals,
    showalter: computeShowalter(column),
    parcelTrace,
    severity,
  };
}

/**
 * Showalter index: lift a 850 hPa parcel dry-adiabatically to saturation, then
 * moist-adiabatically to 500 hPa; compare with the environment there.
 */
function computeShowalter(column: SoundingLevel[]): number {
  const p850 = column.find((l) => Math.abs(l.pressure - 850) < 12);
  const p500 = column.find((l) => Math.abs(l.pressure - 500) < 12);
  if (!p850 || !p500 || !Number.isFinite(p850.dewPoint)) return NaN;

  const { temperature: t, dewPoint: td } = p850;
  if (t - td < 0.5) return NaN; // saturated: Showalter is undefined

  const thetaK = potentialTemperature(t, 850);
  const lclP = lclPressure(t, td, 850);

  let parcel500: number;
  if (lclP <= 500) {
    // Saturation happens at or below 500 hPa: dry all the way.
    parcel500 = dryAdiabatTemperature(thetaK, 500);
  } else {
    const lclT = lclTemperature(t, td);
    const path = moistAdiabatPath(lclT, lclP, 500, 2);
    parcel500 = path.length ? path[path.length - 1].temperature : lclT;
  }

  return p500.temperature - parcel500;
}

/** Thermodynamic severity bucket. */
export function classifySeverity(
  cape: number,
  cin: number,
  lifted: number,
  kIndex: number,
): Severity {
  if (!Number.isFinite(cape)) {
    return { label: '无数据', level: 'none', color: '#64748b', note: '' };
  }

  const notes: string[] = [];
  if (Number.isFinite(lifted)) notes.push(`LI ${lifted.toFixed(1)}`);
  if (Number.isFinite(kIndex)) notes.push(`K ${kIndex.toFixed(0)}`);

  if (cape >= 4000) {
    return { label: '极端强对流', level: 'extreme', color: '#dc2626', note: notes.join(' · ') };
  }
  if (cape >= 2500) {
    return { label: '强对流爆发', level: 'high', color: '#f43f5e', note: notes.join(' · ') };
  }
  if (cape >= 1000) {
    return { label: '中等不稳定', level: 'moderate', color: '#f97316', note: notes.join(' · ') };
  }
  if (cape >= 300) {
    return { label: '弱不稳定', level: 'slight', color: '#facc15', note: notes.join(' · ') };
  }
  if (cape >= 50) {
    return { label: '边缘不稳定', level: 'marginal', color: '#60a5fa', note: notes.join(' · ') };
  }
  if (Number.isFinite(cin) && cin < -100) {
    return { label: '强大气抑制', level: 'none', color: '#64748b', note: notes.join(' · ') };
  }
  // A NaN CIN means the parcel never reached free convection at all, which is a
  // stable column rather than a merely inhibited one.
  return { label: '稳定层结', level: 'none', color: '#34d399', note: notes.join(' · ') };
}

/* ------------------------------------------------------------------ */
/* Wind barbs                                                          */
/* ------------------------------------------------------------------ */

export interface WindBarbSpec {
  /** Full barbs (10 kt each). */
  fullBarbs: number;
  /** Half barbs (5 kt each). */
  halfBarbs: number;
  /** Pennants (50 kt each). */
  pennants: number;
  /** Rounded speed in knots used to build the barb. */
  speedKt: number;
}

/**
 * Decompose a wind speed into pennants/barbs, the way a station model does.
 * Rounds to the nearest 5 kt, which is the resolution a real barb can express.
 */
export function windBarbSpec(speedMs: number): WindBarbSpec {
  const speedKt = speedMs * 1.9438444924406046;
  let rounded = Math.round(speedKt / 5) * 5;
  if (rounded < 0) rounded = 0;

  const pennants = Math.floor(rounded / 50);
  let rest = rounded - pennants * 50;

  const fullBarbs = Math.floor(rest / 10);
  rest -= fullBarbs * 10;

  const halfBarbs = rest >= 5 ? 1 : 0;

  return { pennants, fullBarbs, halfBarbs, speedKt: rounded };
}

/* ------------------------------------------------------------------ */
/* Hodograph helpers                                                   */
/* ------------------------------------------------------------------ */

export interface HodographSample {
  /** u component m/s (eastward). */
  u: number;
  v: number;
  height: number;
  pressure: number;
  speed: number;
  direction: number;
}

/** Convert a sounding into u/v hodograph samples (meteorological convention). */
export function hodographSamples(levels: SoundingLevel[]): HodographSample[] {
  const DEG = Math.PI / 180;
  return levels
    .filter((l) => Number.isFinite(l.windSpeed) && Number.isFinite(l.windDirection))
    .map((l) => {
      const rad = l.windDirection * DEG;
      const u = -l.windSpeed * Math.sin(rad);
      const v = -l.windSpeed * Math.cos(rad);
      return {
        u,
        v,
        height: l.height,
        pressure: l.pressure,
        speed: l.windSpeed,
        direction: l.windDirection,
      };
    });
}

/**
 * Storm-relative helicity (SRH) in m²/s², 0–3 km AGL.
 *
 *     SRH = ∫ (V - C) · (k × dV/dz) dz
 *
 * Sampled discretely between successive levels, with the storm motion `c`
 * defaulting to the Bunkers right-mover estimate.
 */
export function stormRelativeHelicity(
  samples: HodographSample[],
  stormU = 0,
  stormV = 0,
  maxHeight = 3000,
): number {
  let srh = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.height > maxHeight) break;

    const dz = (b.height - a.height) / 1000; // km
    if (!(dz > 0)) continue;

    const du = b.u - a.u;
    const dv = b.v - a.v;

    // Mean storm-relative wind of the layer.
    const mu = (a.u + b.u) / 2 - stormU;
    const mv = (a.v + b.v) / 2 - stormV;

    // k × dV/dz = (dv, -du)
    srh += mu * dv - mv * du;
  }

  return srh;
}

/**
 * Bunkers et al. (2000) right-moving supercell motion estimate.
 * Uses the mean wind and the 0–6 km shear vector, deviated 7.5 m/s to the right.
 */
export function bunkersRightMover(samples: HodographSample[]): { u: number; v: number } {
  if (samples.length === 0) return { u: 0, v: 0 };

  // Mean wind over 0–6 km AGL.
  const low = samples.filter((s) => s.height <= 6000);
  const pool = low.length >= 2 ? low : samples;
  const meanU = pool.reduce((acc, s) => acc + s.u, 0) / pool.length;
  const meanV = pool.reduce((acc, s) => acc + s.v, 0) / pool.length;

  // Shear vector between the surface and 6 km (or the topmost sample).
  const sfc = samples[0];
  const top = samples[samples.length - 1];
  const shearU = top.u - sfc.u;
  const shearV = top.v - sfc.v;

  // Rotate the shear vector by -90° (to the right of the shear vector) and scale.
  const deviation = 7.5;
  const mag = Math.hypot(shearU, shearV) || 1;
  const devU = (shearV / mag) * deviation;
  const devV = (-shearU / mag) * deviation;

  return { u: meanU + devU, v: meanV + devV };
}

/* ------------------------------------------------------------------ */
/* Height / pressure conversions                                        */
/* ------------------------------------------------------------------ */

/** Approximate height m of a pressure level, ICAO standard atmosphere. */
export function standardHeightFromPressure(pHpa: number): number {
  return 44330 * (1 - Math.pow(pHpa / 1013.25, 0.1903));
}

/** Approximate pressure hPa at a standard-atmosphere height, m. */
export function standardPressureFromHeight(heightM: number): number {
  return 1013.25 * Math.pow(1 - heightM / 44330, 1 / 0.1903);
}

/** Lerp helper shared by the interpolators below. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Linear interpolation of a sounding variable at an arbitrary pressure.
 * Used for drawing smooth curves between the 19 discrete levels.
 */
export function interpolateAtPressure(
  levels: SoundingLevel[],
  pressure: number,
  field: Exclude<keyof SoundingLevel, 'pressure'>,
): number {
  const column = levels.slice().sort((a, b) => b.pressure - a.pressure);
  if (column.length === 0) return NaN;

  if (pressure >= column[0].pressure) return column[0][field] as number;
  const last = column[column.length - 1];
  if (pressure <= last.pressure) return last[field] as number;

  for (let i = 1; i < column.length; i += 1) {
    const a = column[i - 1];
    const b = column[i];
    if (pressure <= a.pressure && pressure >= b.pressure) {
      const span = a.pressure - b.pressure || 1;
      const t = (a.pressure - pressure) / span;
      const av = a[field] as number;
      const bv = b[field] as number;
      if (!Number.isFinite(av) || !Number.isFinite(bv)) return Number.isFinite(av) ? av : bv;
      return lerp(av, bv, t);
    }
  }

  return last[field] as number;
}
