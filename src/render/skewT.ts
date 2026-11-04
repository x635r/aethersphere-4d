/**
 * Skew-T / Log-P diagram renderer.
 *
 * Geometry conventions follow the standard US skew-T: isobars horizontal at
 * log-pressure spacing, isotherms tilted 45° to the right, temperature
 * increasing to the right. The skew transform is applied to X only, so every
 * curve (environment, dew point, parcel, moist adiabats) is drawn through the
 * same `xFor` mapper and therefore agrees pixel-for-pixel with the graticule.
 *
 * Drawing is done on a 2D canvas with device-pixel-ratio scaling so it stays
 * crisp on HiDPI displays, and the whole plot is a pure function of
 * (layout, data) — no internal mutation, so React can re-render it freely.
 */

import {
  computeSoundingDiagnostics,
  hodographSamples,
  bunkersRightMover,
  stormRelativeHelicity,
  moistAdiabatPath,
  windBarbSpec,
  type SoundingLevel,
  type SoundingDiagnostics,
  type HodographSample,
} from '../utils/thermodynamics';

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

export interface SkewTLayout {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  /** Pressure range of the plot, hPa (bottom/top). */
  pBottom: number;
  pTop: number;
  /** Temperature range at the bottom edge, °C. */
  tMin: number;
  tMax: number;
}

export const DEFAULT_LAYOUT: SkewTLayout = {
  width: 620,
  height: 640,
  padding: { top: 18, right: 78, bottom: 34, left: 52 },
  pBottom: 1050,
  pTop: 100,
  tMin: -40,
  tMax: 50,
};

/** Skew factor: how far a temperature shifts right per decade of pressure. */
const SKEW = 1.0;

export interface SkewTTheme {
  background: string;
  gridStrong: string;
  gridWeak: string;
  isotherm: string;
  isothermZero: string;
  dryAdiabat: string;
  moistAdiabat: string;
  mixingRatio: string;
  temperature: string;
  dewPoint: string;
  parcel: string;
  capeFill: string;
  cinFill: string;
  text: string;
  textDim: string;
  frame: string;
}

export const DEFAULT_THEME: SkewTTheme = {
  background: '#040a14',
  gridStrong: 'rgba(148, 163, 184, 0.30)',
  gridWeak: 'rgba(148, 163, 184, 0.13)',
  isotherm: 'rgba(56, 189, 248, 0.20)',
  isothermZero: 'rgba(125, 211, 252, 0.85)',
  dryAdiabat: 'rgba(161, 98, 7, 0.30)',
  moistAdiabat: 'rgba(16, 185, 129, 0.26)',
  mixingRatio: 'rgba(168, 85, 247, 0.24)',
  temperature: '#f87171',
  dewPoint: '#4ade80',
  parcel: '#fbbf24',
  capeFill: 'rgba(244, 63, 94, 0.22)',
  cinFill: 'rgba(34, 211, 238, 0.16)',
  text: '#e2e8f0',
  textDim: 'rgba(148, 163, 184, 0.85)',
  frame: 'rgba(34, 211, 238, 0.25)',
};

/* ------------------------------------------------------------------ */
/* Projections                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pressure -> pixel Y, increasing downward.
 *
 * pBottom (1050 hPa) maps to the bottom edge, pTop (100 hPa) to the top edge,
 * with log spacing in between, so altitude increases as y decreases.
 */
export function yForPressure(p: number, layout: SkewTLayout): number {
  const { padding, height, pBottom, pTop } = layout;
  const plotHeight = height - padding.top - padding.bottom;
  const lo = Math.log(pBottom);
  const hi = Math.log(pTop);
  // t = 0 at pBottom (bottom edge), t = 1 at pTop (top edge).
  const t = (lo - Math.log(Math.max(1, p))) / (lo - hi);
  return padding.top + (1 - t) * plotHeight;
}

/** Inverse of yForPressure. */
export function pressureForY(y: number, layout: SkewTLayout): number {
  const { padding, height, pBottom, pTop } = layout;
  const plotHeight = height - padding.top - padding.bottom;
  const t = 1 - (y - padding.top) / plotHeight;
  const lo = Math.log(pBottom);
  const hi = Math.log(pTop);
  return Math.exp(lo - t * (lo - hi));
}

/**
 * Temperature -> pixel X at a given pressure.
 *
 * This is the skew transform. A parcel at `t` sits at the x where a straight
 * 45° isotherm through it would cross the bottom axis; equivalently, x shifts
 * right as pressure decreases.
 */
export function xForTemp(t: number, p: number, layout: SkewTLayout): number {
  const { padding, width, pBottom, tMin, tMax } = layout;
  const plotWidth = width - padding.left - padding.right;
  const base = (t - tMin) / (tMax - tMin);
  const skewShift = Math.log(pBottom / Math.max(1, p)) * SKEW * 0.42;
  return padding.left + (base + skewShift) * plotWidth;
}

/** Inverse of xForTemp: temperature at a given pixel X and pressure. */
export function tempForX(x: number, p: number, layout: SkewTLayout): number {
  const { padding, width, pBottom, tMin, tMax } = layout;
  const plotWidth = width - padding.left - padding.right;
  const skewShift = Math.log(pBottom / Math.max(1, p)) * SKEW * 0.42;
  const base = (x - padding.left) / plotWidth - skewShift;
  return tMin + base * (tMax - tMin);
}

/* ------------------------------------------------------------------ */
/* Termodynamic curves for the background                             */
/* ------------------------------------------------------------------ */

/** Dry adiabats for a set of potential temperatures. */
export function dryAdiabatCurves(
  layout: SkewTLayout,
  thetas: number[],
  steps = 40,
): { theta: number; points: { p: number; t: number }[] }[] {
  const out: { theta: number; points: { p: number; t: number }[] }[] = [];

  for (const thetaK of thetas) {
    const points: { p: number; t: number }[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const frac = i / steps;
      const p = layout.pBottom * Math.pow(layout.pTop / layout.pBottom, frac);
      const t = thetaK * Math.pow(p / 1000, 287.05 / 1005.7) - 273.15;
      points.push({ p, t });
    }
    out.push({ theta: thetaK, points });
  }

  return out;
}

/**
 * Moist adiabats, seeded by their θe. Each is integrated from the plot bottom
 * upward, which is how the green curves on a real skew-T are constructed.
 */
export function moistAdiabatCurves(
  layout: SkewTLayout,
  startTemps: number[],
): { seed: number; points: { p: number; t: number }[] }[] {
  return startTemps.map((seed) => ({
    seed,
    points: moistAdiabatPath(seed, layout.pBottom, layout.pTop, 5).map((pt) => ({
      p: pt.pressure,
      t: pt.temperature,
    })),
  }));
}

/** Saturation mixing-ratio lines, labelled in g/kg. */
export function mixingRatioCurves(
  layout: SkewTLayout,
  valuesGPerKg: number[],
): { value: number; points: { p: number; t: number }[] }[] {
  return valuesGPerKg.map((gkg) => {
    const w = gkg / 1000;
    const points: { p: number; t: number }[] = [];

    for (let i = 0; i <= 30; i += 1) {
      const frac = i / 30;
      const p = layout.pBottom * Math.pow(layout.pTop / layout.pBottom, frac);
      // Invert w = eps*e/(p-e) for e, then e -> dew point.
      const e = (w * p) / (EPSILON + w);
      const ln = Math.log(Math.max(e, 1e-6) / 6.112);
      const td = (243.5 * ln) / (17.67 - ln);
      points.push({ p, t: td });
    }

    return { value: gkg, points };
  });
}

const EPSILON = 0.622;

/* ------------------------------------------------------------------ */
/* Renderer                                                           */
/* ------------------------------------------------------------------ */

export interface SkewTRenderInput {
  levels: SoundingLevel[];
  layout?: SkewTLayout;
  theme?: SkewTTheme;
  /** Pixel ratio override; defaults to devicePixelRatio. */
  pixelRatio?: number;
  showBackground?: boolean;
  showParcel?: boolean;
  showBarbs?: boolean;
  /** Hovered level index, highlighted if set. */
  highlightIndex?: number | null;
}

export interface SkewTRenderResult {
  diagnostics: SoundingDiagnostics;
  hodograph: HodographSample[];
  /** Bounding boxes for hit-testing, in CSS pixels. */
  hitPoints: { x: number; y: number; level: SoundingLevel; kind: 'temp' | 'dew' }[];
}

/**
 * Draw the whole diagram. Returns the diagnostics so the caller can render the
 * index cards from the exact same numbers the plot was built from.
 */
export function renderSkewT(
  ctx: CanvasRenderingContext2D,
  input: SkewTRenderInput,
): SkewTRenderResult {
  const layout = input.layout ?? DEFAULT_LAYOUT;
  const theme = input.theme ?? DEFAULT_THEME;
  const ratio = input.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);

  // Plot background.
  const plotLeft = layout.padding.left;
  const plotTop = layout.padding.top;
  const plotWidth = layout.width - layout.padding.left - layout.padding.right;
  const plotHeight = layout.height - layout.padding.top - layout.padding.bottom;

  ctx.fillStyle = theme.background;
  ctx.fillRect(plotLeft, plotTop, plotWidth, plotHeight);

  if (input.showBackground !== false) {
    drawIsobars(ctx, layout, theme);
    drawIsotherms(ctx, layout, theme);
    drawDryAdiabats(ctx, layout, theme);
    drawMoistAdiabats(ctx, layout, theme);
    drawMixingRatioLines(ctx, layout, theme);
    drawAxes(ctx, layout, theme);
  }

  const diagnostics = computeSoundingDiagnostics(input.levels);

  // CAPE / CIN shading must sit under the curves.
  if (input.showParcel !== false) {
    drawParcelShading(ctx, layout, theme, diagnostics);
  }

  drawProfiles(ctx, layout, theme, input.levels, input.highlightIndex ?? null);
  drawParcelCurve(ctx, layout, theme, diagnostics);
  drawLclMarker(ctx, layout, theme, diagnostics);

  const hodograph = hodographSamples(input.levels);
  if (input.showBarbs !== false) {
    drawWindBarbs(ctx, layout, theme, input.levels);
  }

  drawFrame(ctx, layout, theme);

  const hitPoints = buildHitPoints(layout, input.levels);

  ctx.restore();

  return { diagnostics, hodograph, hitPoints };
}

/* ------------------------------------------------------------------ */
/* Background pieces                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run `paint` with the canvas clipped to the plot rectangle.
 *
 * Background families (dry/moist adiabats, mixing-ratio lines) legitimately
 * extend past the plot edges — a 200 °C potential temperature adiabat leaves the
 * right of the chart long before 100 hPa. Without clipping, those segments are
 * drawn over the labels and the frame, which is what produced the solid wedge
 * at the top of the chart.
 */
function withPlotClip(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  paint: () => void,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    layout.padding.left,
    layout.padding.top,
    layout.width - layout.padding.left - layout.padding.right,
    layout.height - layout.padding.top - layout.padding.bottom,
  );
  ctx.clip();
  paint();
  ctx.restore();
}

function drawIsobars(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  const isobars = [1000, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const p of isobars) {
    if (p > layout.pBottom || p < layout.pTop) continue;
    const y = yForPressure(p, layout);

    ctx.strokeStyle = p % 100 === 0 ? theme.gridStrong : theme.gridWeak;
    ctx.beginPath();
    ctx.moveTo(layout.padding.left, y);
    ctx.lineTo(layout.width - layout.padding.right, y);
    ctx.stroke();

    ctx.fillStyle = theme.textDim;
    ctx.fillText(String(p), layout.padding.left - 5, y);
  }

  // Left axis title.
  ctx.save();
  ctx.translate(12, layout.padding.top + (layout.height - layout.padding.top - layout.padding.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.textDim;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText('气压 hPa', 0, 0);
  ctx.restore();
}

function drawIsotherms(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Every 10 °C across a band wide enough to cover the skew.
  for (let t = -110; t <= 60; t += 10) {
    const xBottom = xForTemp(t, layout.pBottom, layout);
    const xTop = xForTemp(t, layout.pTop, layout);

    if (xTop > layout.width || xBottom < 0) continue;

    ctx.strokeStyle = t === 0 ? theme.isothermZero : theme.isotherm;
    ctx.setLineDash(t === 0 ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(xBottom, yForPressure(layout.pBottom, layout));
    ctx.lineTo(xTop, yForPressure(layout.pTop, layout));
    ctx.stroke();
    ctx.setLineDash([]);

    // Label at the bottom axis.
    if (xBottom >= layout.padding.left && xBottom <= layout.width - layout.padding.right) {
      ctx.fillStyle = t === 0 ? '#bae6fd' : theme.textDim;
      ctx.fillText(`${t}`, xBottom, layout.height - layout.padding.bottom + 5);
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = theme.textDim;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(
    '温度 °C',
    layout.padding.left + (layout.width - layout.padding.left - layout.padding.right) / 2,
    layout.height - 12,
  );
}

function drawDryAdiabats(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  const thetas: number[] = [];
  for (let t = -40; t <= 200; t += 20) thetas.push(t + 273.15);

  withPlotClip(ctx, layout, () => {
  ctx.strokeStyle = theme.dryAdiabat;
  ctx.lineWidth = 1;

  for (const curve of dryAdiabatCurves(layout, thetas)) {
    ctx.beginPath();
    let started = false;
    for (const pt of curve.points) {
      const x = xForTemp(pt.t, pt.p, layout);
      const y = yForPressure(pt.p, layout);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  });
}

function drawMoistAdiabats(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  const seeds: number[] = [];
  for (let t = -20; t <= 40; t += 5) seeds.push(t);

  withPlotClip(ctx, layout, () => {
  ctx.strokeStyle = theme.moistAdiabat;
  ctx.lineWidth = 1;

  for (const curve of moistAdiabatCurves(layout, seeds)) {
    ctx.beginPath();
    let started = false;
    for (const pt of curve.points) {
      const x = xForTemp(pt.t, pt.p, layout);
      const y = yForPressure(pt.p, layout);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  });
}

function drawMixingRatioLines(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  const values = [0.4, 1, 2, 4, 8, 12, 16, 20];

  withPlotClip(ctx, layout, () => {
  ctx.strokeStyle = theme.mixingRatio;
  ctx.lineWidth = 1;
  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.mixingRatio;

  for (const curve of mixingRatioCurves(layout, values)) {
    ctx.beginPath();
    let started = false;
    let lastX = 0;
    let lastY = 0;
    for (const pt of curve.points) {
      const x = xForTemp(pt.t, pt.p, layout);
      const y = yForPressure(pt.p, layout);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
      lastY = y;
    }
    ctx.stroke();

    // Label near the top of the line, inside the plot.
    if (lastX > layout.padding.left + 20 && lastX < layout.width - layout.padding.right - 16) {
      ctx.fillText(`${curve.value}`, lastX, lastY - 3);
    }
  }

  // Legend note for the background families.
  ctx.textAlign = 'left';
  ctx.font = '8px ui-monospace, monospace';
  const legendY = layout.padding.top + 8;
  ctx.fillStyle = theme.dryAdiabat;
  ctx.fillText('干绝热线', layout.padding.left + 6, legendY + 10);
  ctx.fillStyle = theme.moistAdiabat;
  ctx.fillText('湿绝热线', layout.padding.left + 6, legendY + 21);
  ctx.fillStyle = theme.mixingRatio;
  ctx.fillText('等饱和比湿 (g/kg)', layout.padding.left + 6, legendY + 32);
  });
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  // Height ticks on the right edge (standard atmosphere altitude).
  const rights: [number, number][] = [];
  for (const p of [1000, 850, 700, 500, 400, 300, 200, 150, 100]) {
    if (p > layout.pBottom || p < layout.pTop) continue;
    const h = 44330 * (1 - Math.pow(p / 1013.25, 0.1903));
    rights.push([p, h / 1000]);
  }

  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.textDim;

  const xRight = layout.width - layout.padding.right + 6;
  for (const [p, km] of rights) {
    const y = yForPressure(p, layout);
    ctx.fillText(`${km.toFixed(1)}km`, xRight, y);
  }

  ctx.save();
  ctx.translate(layout.width - 14, layout.padding.top + (layout.height - layout.padding.top - layout.padding.bottom) / 2);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('海拔', 0, 0);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Parcel, shading and profiles                                       */
/* ------------------------------------------------------------------ */

function drawParcelShading(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
  diagnostics: SoundingDiagnostics,
): void {
  const trace = diagnostics.parcelTrace;
  if (trace.length < 2) return;

  // Cape: fill between the parcel and environment for every buoyant layer.
  // Cin: the same for inhibited layers below the LFC.
  const segments: { positive: boolean; pts: { p: number; a: number; b: number }[] }[] = [];

  let current: { positive: boolean; pts: { p: number; a: number; b: number }[] } | null = null;

  for (const point of trace) {
    const diff = point.parcelTemperature - point.environmentTemperature;
    const positive = diff > 0;

    if (!current || current.positive !== positive) {
      if (current && current.pts.length > 0) segments.push(current);
      current = { positive, pts: [] };
      // Carry the previous point so the fill has no gap at the boundary.
      const idx = trace.indexOf(point);
      if (idx > 0) {
        const prev = trace[idx - 1];
        current.pts.push({
          p: prev.pressure,
          a: prev.parcelTemperature,
          b: prev.environmentTemperature,
        });
      }
    }

    current.pts.push({
      p: point.pressure,
      a: point.parcelTemperature,
      b: point.environmentTemperature,
    });
  }
  if (current && current.pts.length > 0) segments.push(current);

  // The parcel curve can leave the plot horizontally (a very warm parcel at
  // 100 hPa maps far to the right), so the shading is clipped to the plot
  // rectangle like every other field.
  withPlotClip(ctx, layout, () => {
    for (const seg of segments) {
      if (seg.pts.length < 2) continue;

      ctx.beginPath();
      // Down the parcel curve.
      let started = false;
      for (const pt of seg.pts) {
        const x = xForTemp(pt.a, pt.p, layout);
        const y = yForPressure(pt.p, layout);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      // Back up the environment curve.
      for (let i = seg.pts.length - 1; i >= 0; i -= 1) {
        const pt = seg.pts[i];
        ctx.lineTo(xForTemp(pt.b, pt.p, layout), yForPressure(pt.p, layout));
      }
      ctx.closePath();
      ctx.fillStyle = seg.positive ? theme.capeFill : theme.cinFill;
      ctx.fill();
    }
  });
}

function drawProfiles(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
  levels: SoundingLevel[],
  highlightIndex: number | null,
): void {
  const column = levels
    .filter((l) => Number.isFinite(l.temperature))
    .slice()
    .sort((a, b) => b.pressure - a.pressure);

  if (column.length < 1) return;

  // Dew point first so temperature draws on top.
  drawLine(
    ctx,
    layout,
    column.map((l) => ({
      x: xForTemp(l.dewPoint, l.pressure, layout),
      y: yForPressure(l.pressure, layout),
    })),
    theme.dewPoint,
    2,
  );

  drawLine(
    ctx,
    layout,
    column.map((l) => ({
      x: xForTemp(l.temperature, l.pressure, layout),
      y: yForPressure(l.pressure, layout),
    })),
    theme.temperature,
    2.4,
  );

  // Level markers.
  column.forEach((level, index) => {
    const isHot = highlightIndex === index;
    const x = xForTemp(level.temperature, level.pressure, layout);
    const y = yForPressure(level.pressure, layout);

    ctx.beginPath();
    ctx.arc(x, y, isHot ? 4 : 2, 0, Math.PI * 2);
    ctx.fillStyle = theme.temperature;
    ctx.fill();

    if (isHot) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Crosshair through the level for readability.
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(layout.padding.left, y);
      ctx.lineTo(layout.width - layout.padding.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}

function drawParcelCurve(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
  diagnostics: SoundingDiagnostics,
): void {
  const trace = diagnostics.parcelTrace;
  if (trace.length < 2) return;

  // Integrate a full dense parcel path (dry below LCL, moist above) so the
  // curve is smooth rather than a polyline through 19 sparse points.
  const points: { x: number; y: number }[] = [];
  const step = 5;

  for (let p = layout.pBottom; p >= layout.pTop; p -= step) {
    // Find the bracketing trace entries and interpolate.
    let parcelT = Number.NaN;
    for (let i = 1; i < trace.length; i += 1) {
      const a = trace[i - 1];
      const b = trace[i];
      if (p <= a.pressure && p >= b.pressure) {
        const span = a.pressure - b.pressure || 1;
        const t = (a.pressure - p) / span;
        parcelT = a.parcelTemperature + (b.parcelTemperature - a.parcelTemperature) * t;
        break;
      }
    }
    if (!Number.isFinite(parcelT)) continue;

    points.push({
      x: xForTemp(parcelT, p, layout),
      y: yForPressure(p, layout),
    });
  }

  drawLine(ctx, layout, points, theme.parcel, 2, [5, 3]);

}

function drawLclMarker(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
  diagnostics: SoundingDiagnostics,
): void {
  if (!Number.isFinite(diagnostics.lclPressure)) return;

  const y = yForPressure(diagnostics.lclPressure, layout);
  if (y < layout.padding.top || y > layout.height - layout.padding.bottom) return;

  const x = xForTemp(diagnostics.lclTemperature, diagnostics.lclPressure, layout);

  ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.padding.left, y);
  ctx.lineTo(layout.width - layout.padding.right, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.strokeStyle = theme.parcel;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Park the label on the left edge of the plot, where the chart is usually
  // clear at LCL height, with a backing plate so it survives the adiabat
  // hatching. A short leader line ties it back to the marker.
  const label = `LCL ${diagnostics.lclPressure.toFixed(0)} hPa`;
  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const textWidth = ctx.measureText(label).width;
  const labelX = layout.padding.left + 5;
  const labelY = y - 10;

  ctx.fillStyle = 'rgba(4, 10, 20, 0.85)';
  ctx.fillRect(labelX - 2, labelY - 5.5, textWidth + 4, 11);

  ctx.fillStyle = theme.parcel;
  ctx.fillText(label, labelX, labelY);

  ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(labelX + textWidth + 3, labelY);
  ctx.lineTo(x - 6, y - 1);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
}

/* ------------------------------------------------------------------ */
/* Wind barbs                                                         */
/* ------------------------------------------------------------------ */

function drawWindBarbs(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
  levels: SoundingLevel[],
): void {
  const x = layout.width - layout.padding.right + 26;

  ctx.font = '7px ui-monospace, monospace';
  ctx.fillStyle = theme.textDim;
  ctx.textAlign = 'center';
  ctx.fillText('kt', x, layout.padding.top - 6);

  for (const level of levels) {
    if (!Number.isFinite(level.windSpeed)) continue;

    const y = yForPressure(level.pressure, layout);
    if (y < layout.padding.top + 4 || y > layout.height - layout.padding.bottom - 4) continue;

    drawOneBarb(ctx, x, y, level.windSpeed, level.windDirection, theme);
  }
}

/**
 * Draw a single station-model wind barb.
 *
 * The staff points into the wind (meteorological convention), so it is rotated
 * by the "from" direction plus 180° to point upwind. Pennants are triangles,
 * full barbs are 10 kt, half barbs 5 kt.
 */
function drawOneBarb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  speedMs: number,
  directionDeg: number,
  theme: SkewTTheme,
): void {
  const spec = windBarbSpec(speedMs);
  const length = 15;
  const toRad = Math.PI / 180;

  // Staff points toward where the wind comes from.
  const angle = directionDeg * toRad;

  const tipX = cx + Math.sin(angle) * length;
  const tipY = cy - Math.cos(angle) * length;

  ctx.strokeStyle = theme.text;
  ctx.fillStyle = theme.text;
  ctx.lineWidth = 1.2;

  // Calm: a small circle.
  if (spec.speedKt < 2.5) {
    ctx.beginPath();
    ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Perpendicular direction for barbs, pointing upwind (barb side).
  const perpX = Math.cos(angle);
  const perpY = Math.sin(angle);

  let pos = 0;
  const advance = (n: number) => {
    pos += n;
    return {
      x: tipX - Math.sin(angle) * pos,
      y: tipY + Math.cos(angle) * pos,
    };
  };

  // Pennants (50 kt triangles).
  for (let i = 0; i < spec.pennants; i += 1) {
    const base = advance(4.2);
    const tip = advance(4.2);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x + perpX * 6, tip.y + perpY * 6);
    ctx.closePath();
    ctx.fill();
  }

  // Full barbs (10 kt).
  for (let i = 0; i < spec.fullBarbs; i += 1) {
    if (i > 0) advance(3.4);
    const p = advance(0);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + perpX * 6, p.y + perpY * 6);
    ctx.stroke();
  }

  // Half barb (5 kt).
  if (spec.halfBarbs > 0) {
    if (spec.fullBarbs > 0) advance(3.4);
    const p = advance(0);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + perpX * 3.4, p.y + perpY * 3.4);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function drawLine(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  points: { x: number; y: number }[],
  color: string,
  width: number,
  dash?: number[],
): void {
  if (points.length < 2) return;

  ctx.save();
  // Clip to the plotting area so curves never spill into the labels.
  ctx.beginPath();
  ctx.rect(
    layout.padding.left,
    layout.padding.top,
    layout.width - layout.padding.left - layout.padding.right,
    layout.height - layout.padding.top - layout.padding.bottom,
  );
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  layout: SkewTLayout,
  theme: SkewTTheme,
): void {
  ctx.strokeStyle = theme.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    layout.padding.left,
    layout.padding.top,
    layout.width - layout.padding.left - layout.padding.right,
    layout.height - layout.padding.top - layout.padding.bottom,
  );
}

function buildHitPoints(
  layout: SkewTLayout,
  levels: SoundingLevel[],
): { x: number; y: number; level: SoundingLevel; kind: 'temp' | 'dew' }[] {
  const out: { x: number; y: number; level: SoundingLevel; kind: 'temp' | 'dew' }[] = [];

  for (const level of levels) {
    if (!Number.isFinite(level.temperature)) continue;
    out.push({
      x: xForTemp(level.temperature, level.pressure, layout),
      y: yForPressure(level.pressure, layout),
      level,
      kind: 'temp',
    });
    if (Number.isFinite(level.dewPoint)) {
      out.push({
        x: xForTemp(level.dewPoint, level.pressure, layout),
        y: yForPressure(level.pressure, layout),
        level,
        kind: 'dew',
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Hodograph                                                          */
/* ------------------------------------------------------------------ */

export interface HodographRenderInput {
  samples: HodographSample[];
  size?: number;
  pixelRatio?: number;
}

export interface HodographRenderResult {
  /** Storm motion (u,v) in m/s. */
  storm: { u: number; v: number };
  /** Storm-relative helicity 0-3 km, m²/s². */
  srh: number;
  /** 0-6 km bulk shear magnitude, m/s. */
  bulkShear: number;
  maxSpeed: number;
}

/**
 * Draw a polar hodograph: u on X, v on Y, rings at fixed speed intervals.
 * The 0–6 km shear vector and the Bunkers storm motion are overlaid because
 * those are the two quantities a forecaster actually reads off a hodograph.
 */
export function renderHodograph(
  ctx: CanvasRenderingContext2D,
  input: HodographRenderInput,
): HodographRenderResult {
  const size = input.size ?? 168;
  const ratio = input.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 14;

  const maxSpeed = Math.max(
    12,
    ...input.samples.map((s) => s.speed),
  );
  const scale = radius / maxSpeed;

  // Rings.
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  ctx.lineWidth = 1;
  const ringStep = maxSpeed > 40 ? 20 : maxSpeed > 20 ? 10 : 5;
  for (let s = ringStep; s <= maxSpeed; s += ringStep) {
    ctx.beginPath();
    ctx.arc(cx, cy, s * scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Axes.
  ctx.strokeStyle = 'rgba(148,163,184,0.22)';
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // Compass labels.
  ctx.font = '7px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(148,163,184,0.7)';
  ctx.textAlign = 'center';
  ctx.fillText('E', cx + radius - 4, cy + 9);
  ctx.fillText('W', cx - radius + 4, cy + 9);
  ctx.fillText('N', cx + 1, cy - radius + 4);
  ctx.fillText('S', cx + 1, cy + radius + 2);

  // Trace, coloured by height.
  ctx.lineWidth = 1.8;
  for (let i = 1; i < input.samples.length; i += 1) {
    const a = input.samples[i - 1];
    const b = input.samples[i];

    const x1 = cx + a.u * scale;
    const y1 = cy - a.v * scale;
    const x2 = cx + b.u * scale;
    const y2 = cy - b.v * scale;

    // 0 km = green (surface), 6 km = magenta (upper).
    const t = Math.min(1, Math.max(0, (b.height - input.samples[0].height) / 6000));
    ctx.strokeStyle = `hsl(${150 - t * 150}, 75%, 62%)`;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Height dots at 1, 3 and 6 km.
  for (const target of [1000, 3000, 6000]) {
    const s = input.samples.find((p) => p.height >= target);
    if (!s) continue;
    ctx.beginPath();
    ctx.arc(cx + s.u * scale, cy - s.v * scale, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
  }

  // Bunkers right-mover and shear vector.
  const storm = bunkersRightMover(input.samples);
  const sfc = input.samples[0];
  const top = input.samples[input.samples.length - 1];

  if (sfc && top) {
    ctx.strokeStyle = 'rgba(251,191,36,0.85)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx + sfc.u * scale, cy - sfc.v * scale);
    ctx.lineTo(cx + top.u * scale, cy - top.v * scale);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.arc(cx + storm.u * scale, cy - storm.v * scale, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  ctx.restore();

  const srh = stormRelativeHelicity(input.samples, storm.u, storm.v);
  const bulkShear = sfc && top ? Math.hypot(top.u - sfc.u, top.v - sfc.v) : 0;

  return { storm, srh, bulkShear, maxSpeed };
}
