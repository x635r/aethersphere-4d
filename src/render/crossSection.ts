/**
 * Cross-section renderer — the "atmospheric scalpel".
 *
 * Draws a vertical slice through the atmosphere: distance along the transect on
 * X, pressure (log) on the Y axis. Four physical fields share the canvas:
 *
 *   1. Cloud / moisture volume  — RH + cloud cover, bilinearly upsampled.
 *   2. Temperature              — filled ramp plus 0 °C and -20 °C isolines.
 *   3. Wind speed               — >30 m/s regions outlined as jet streaks.
 *   4. Circulation arrows       — along-section wind + vertical velocity.
 *
 * Everything is a pure function of the input arrays, so the component can
 * re-render at will (hover, resize) without accumulating canvas state.
 */

import type { CrossSectionData } from '../data/sounding';

export interface SectionLayout {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  /** Pressure range, hPa. */
  pBottom: number;
  pTop: number;
}

export const DEFAULT_SECTION_LAYOUT: SectionLayout = {
  width: 980,
  height: 420,
  padding: { top: 22, right: 64, bottom: 38, left: 54 },
  pBottom: 1000,
  pTop: 100,
};

export interface SectionTheme {
  background: string;
  frame: string;
  grid: string;
  text: string;
  textDim: string;
  cloud: string;
  coldFill: string;
  warmFill: string;
  zeroIso: string;
  iceIso: string;
  jet: string;
  jetCore: string;
  arrow: string;
  arrowUp: string;
  arrowDown: string;
}

export const DEFAULT_SECTION_THEME: SectionTheme = {
  background: '#040a14',
  frame: 'rgba(34,211,238,0.25)',
  grid: 'rgba(148,163,184,0.14)',
  text: '#e2e8f0',
  textDim: 'rgba(148,163,184,0.85)',
  cloud: 'rgba(226,232,240,0.55)',
  coldFill: 'rgba(30,64,175,0.30)',
  warmFill: 'rgba(190,24,93,0.26)',
  zeroIso: 'rgba(125,211,252,0.95)',
  iceIso: 'rgba(191,219,254,0.6)',
  jet: 'rgba(232,121,249,0.5)',
  jetCore: 'rgba(232,121,249,0.95)',
  arrow: 'rgba(226,232,240,0.75)',
  arrowUp: '#34d399',
  arrowDown: '#fb7185',
};

/* ------------------------------------------------------------------ */
/* Projections                                                        */
/* ------------------------------------------------------------------ */

/** Distance along the transect -> pixel X. */
export function xForDistance(distanceKm: number, lengthKm: number, layout: SectionLayout): number {
  const plotWidth = layout.width - layout.padding.left - layout.padding.right;
  const t = lengthKm > 0 ? distanceKm / lengthKm : 0;
  return layout.padding.left + t * plotWidth;
}

/**
 * Pressure -> pixel Y, with the surface at the bottom.
 *
 * y is anchored so pBottom (1000 hPa) lands on the bottom edge and pTop
 * (100 hPa) on the top edge, with log spacing between; altitude therefore
 * increases upward, matching every published cross-section.
 */
export function yForPressureSection(p: number, layout: SectionLayout): number {
  const plotHeight = layout.height - layout.padding.top - layout.padding.bottom;
  const lo = Math.log(layout.pBottom);
  const hi = Math.log(layout.pTop);
  // t = 0 at pBottom (bottom edge), t = 1 at pTop (top edge).
  const t = (lo - Math.log(Math.max(1, p))) / (lo - hi);
  return layout.padding.top + (1 - t) * plotHeight;
}

/** Inverse: pixel Y -> pressure. */
export function pressureForYSection(y: number, layout: SectionLayout): number {
  const plotHeight = layout.height - layout.padding.top - layout.padding.bottom;
  const t = 1 - (y - layout.padding.top) / plotHeight;
  const lo = Math.log(layout.pBottom);
  const hi = Math.log(layout.pTop);
  return Math.exp(lo - t * (lo - hi));
}

/** Distance -> fraction along the transect, for hit-testing. */
export function distanceForX(x: number, lengthKm: number, layout: SectionLayout): number {
  const plotWidth = layout.width - layout.padding.left - layout.padding.right;
  const t = (x - layout.padding.left) / plotWidth;
  return Math.max(0, Math.min(1, t)) * lengthKm;
}

/** Nearest along-track sample index for a pixel X. */
export function sampleIndexForX(
  x: number,
  samples: CrossSectionData['samples'],
  lengthKm: number,
  layout: SectionLayout,
): number {
  const target = distanceForX(x, lengthKm, layout);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const d = Math.abs(samples[i].distanceKm - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Bilinear upsampling                                                */
/* ------------------------------------------------------------------ */

interface FieldGrid {
  cols: number;
  rows: number;
  /** Row-major, row 0 = the highest pressure (bottom of the plot). */
  values: Float32Array;
  min: number;
  max: number;
}

/**
 * Pack one variable into a [cols x rows] grid.
 *
 * The section has only 20-30 along-track columns and ~15 levels, which would
 * look blocky if drawn as flat cells. Everything is therefore bilinearly
 * upsampled onto a finer canvas grid before colour mapping.
 */
function buildFieldGrid(
  data: CrossSectionData,
  pick: (sample: CrossSectionData['samples'][number], levelIndex: number) => number,
): FieldGrid {
  const cols = data.samples.length;
  const rows = data.levels.length;
  const values = new Float32Array(cols * rows);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = pick(data.samples[c], r);
      values[r * cols + c] = v;
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max - min < 1e-6) max = min + 1;

  return { cols, rows, values, min, max };
}

/** Bilinear sample from a field grid at fractional (col, row). */
function sampleGrid(grid: FieldGrid, col: number, row: number): number {
  const c0 = Math.max(0, Math.min(grid.cols - 1, Math.floor(col)));
  const r0 = Math.max(0, Math.min(grid.rows - 1, Math.floor(row)));
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const fx = Math.max(0, Math.min(1, col - c0));
  const fy = Math.max(0, Math.min(1, row - r0));

  const v00 = grid.values[r0 * grid.cols + c0];
  const v10 = grid.values[r0 * grid.cols + c1];
  const v01 = grid.values[r1 * grid.cols + c0];
  const v11 = grid.values[r1 * grid.cols + c1];

  const values = [v00, v10, v01, v11].filter(Number.isFinite);
  if (values.length === 0) return Number.NaN;
  if (values.length < 4) return values.reduce((a, b) => a + b, 0) / values.length;

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/* ------------------------------------------------------------------ */
/* Colour ramps                                                       */
/* ------------------------------------------------------------------ */

/** Temperature ramp: deep blue (cold) -> white (0 °C) -> red (warm). */
function temperatureColor(tC: number): [number, number, number, number] {
  // Anchor the ramp on physically meaningful temperatures for the troposphere.
  const stops: { t: number; rgb: [number, number, number] }[] = [
    { t: -80, rgb: [30, 27, 75] },
    { t: -60, rgb: [37, 99, 235] },
    { t: -40, rgb: [56, 189, 248] },
    { t: -20, rgb: [147, 197, 253] },
    { t: 0, rgb: [241, 245, 249] },
    { t: 15, rgb: [251, 191, 36] },
    { t: 30, rgb: [239, 68, 68] },
    { t: 45, rgb: [153, 27, 27] },
  ];

  if (!Number.isFinite(tC)) return [0, 0, 0, 0];

  if (tC <= stops[0].t) return [...stops[0].rgb, 1] as [number, number, number, number];
  const last = stops[stops.length - 1];
  if (tC >= last.t) return [...last.rgb, 1] as [number, number, number, number];

  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    if (tC >= a.t && tC <= b.t) {
      const f = (tC - a.t) / (b.t - a.t);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
        1,
      ];
    }
  }

  return [128, 128, 128, 1];
}

/* ------------------------------------------------------------------ */
/* Renderer                                                           */
/* ------------------------------------------------------------------ */

export interface SectionRenderInput {
  data: CrossSectionData;
  layout?: SectionLayout;
  theme?: SectionTheme;
  pixelRatio?: number;
  /** Index of the highlighted along-track sample, or null. */
  highlightIndex?: number | null;
  showClouds?: boolean;
  showTemperature?: boolean;
  showJets?: boolean;
  showCirculation?: boolean;
}

export interface SectionRenderResult {
  /** Per-level min/max temperature, for the legend. */
  temperatureRange: { min: number; max: number };
  maxWindSpeed: number;
  /** Fraction of the slice above 30 m/s (jet coverage). */
  jetCoverage: number;
  /** Index of the strongest jet sample, or -1. */
  jetIndex: number;
}

export function renderCrossSection(
  ctx: CanvasRenderingContext2D,
  input: SectionRenderInput,
): SectionRenderResult {
  const layout = input.layout ?? DEFAULT_SECTION_LAYOUT;
  const theme = input.theme ?? DEFAULT_SECTION_THEME;
  const data = input.data;
  const ratio = input.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);

  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  ctx.fillStyle = theme.background;
  ctx.fillRect(plotX, plotY, plotW, plotH);

  const hasData = data.samples.length >= 2 && data.levels.length >= 2;

  if (!hasData) {
    ctx.fillStyle = theme.textDim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待剖面数据…', layout.width / 2, layout.height / 2);
    ctx.restore();
    return {
      temperatureRange: { min: 0, max: 0 },
      maxWindSpeed: 0,
      jetCoverage: 0,
      jetIndex: -1,
    };
  }

  const tempGrid = buildFieldGrid(data, (s, r) => s.temperature[r]);
  const rhGrid = buildFieldGrid(data, (s, r) => s.relativeHumidity[r]);
  const cloudGrid = buildFieldGrid(data, (s, r) => s.cloudCover[r]);
  const windGrid = buildFieldGrid(data, (s, r) => s.windSpeed[r]);

  // ---- 1. temperature fill ---------------------------------------------
  if (input.showTemperature !== false) {
    drawTemperatureField(ctx, layout, data, tempGrid);
  }

  // ---- 2. cloud / moisture volume --------------------------------------
  if (input.showClouds !== false) {
    drawCloudVolume(ctx, layout, data, rhGrid, cloudGrid);
  }

  // ---- 3. isolines ------------------------------------------------------
  drawIsotherms(ctx, layout, tempGrid, theme);

  // ---- 4. jet streaks ---------------------------------------------------
  if (input.showJets !== false) {
    drawJetStreaks(ctx, layout, windGrid, theme);
  }

  // ---- 5. circulation arrows -------------------------------------------
  if (input.showCirculation !== false) {
    drawCirculation(ctx, layout, data, theme);
  }

  // ---- 6. axes, frame, cursor ------------------------------------------
  drawSectionAxes(ctx, layout, data, theme);
  drawSectionFrame(ctx, layout, theme);
  drawHighlight(ctx, layout, data, input.highlightIndex ?? null, theme);

  ctx.restore();

  // ---- statistics for the legend ---------------------------------------
  let maxWind = 0;
  let jetIndex = -1;
  let cells = 0;
  let jetCells = 0;

  for (const sample of data.samples) {
    for (let r = 0; r < data.levels.length; r += 1) {
      const v = sample.windSpeed[r];
      if (!Number.isFinite(v)) continue;
      cells += 1;
      if (v > maxWind) maxWind = v;
      if (v >= 30) jetCells += 1;
    }
    sample.windSpeed.forEach((v) => {
      if (Number.isFinite(v) && v === maxWind) {
        jetIndex = data.samples.indexOf(sample);
      }
    });
  }

  return {
    temperatureRange: { min: tempGrid.min, max: tempGrid.max },
    maxWindSpeed: maxWind,
    jetCoverage: cells > 0 ? jetCells / cells : 0,
    jetIndex,
  };
}

/* ------------------------------------------------------------------ */
/* Field painting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Paint the temperature field by iterating over the destination pixel grid and
 * bilinearly sampling the source field. Sampling per destination pixel (rather
 * than stretching a tiny ImageData) is what gives the smooth gradient.
 */
function drawTemperatureField(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  data: CrossSectionData,
  grid: FieldGrid,
): void {
  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  const step = 3; // sampling stride in CSS px; small enough to look smooth
  const cols = Math.ceil(plotW / step);
  const rows = Math.ceil(plotH / step);

  let imageData: ImageData | null = null;
  try {
    imageData = ctx.createImageData(cols, rows);
  } catch {
    return;
  }
  if (!imageData) return;

  const px = imageData.data;

  for (let j = 0; j < rows; j += 1) {
    const y = plotY + j * step;
    const p = pressureForYSection(y, layout);

    // Row index in the source grid: row 0 is the plot bottom (highest pressure).
    const rowPos = rowForPressure(p, data.levels);

    for (let i = 0; i < cols; i += 1) {
      const colPos = (i / Math.max(1, cols - 1)) * (grid.cols - 1);
      const t = sampleGrid(grid, colPos, rowPos);
      const [r, g, b, a] = temperatureColor(t);
      const o = (j * cols + i) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = Math.round(a * 210);
    }
  }

  // Draw the sampled patch, scaled up with smoothing.
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;
  offCtx.putImageData(imageData, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, plotX, plotY, plotW, plotH);
  ctx.restore();
}

/** Fractional row index for a pressure, matching the stored level ordering. */
function rowForPressure(p: number, levels: number[]): number {
  // levels[0] is the highest pressure (bottom of the plot).
  if (levels.length < 2) return 0;

  if (p >= levels[0]) return 0;
  if (p <= levels[levels.length - 1]) return levels.length - 1;

  for (let i = 1; i < levels.length; i += 1) {
    if (p <= levels[i - 1] && p >= levels[i]) {
      const span = levels[i - 1] - levels[i] || 1;
      return i - 1 + (levels[i - 1] - p) / span;
    }
  }

  return levels.length - 1;
}

/**
 * Cloud / moisture volume.
 *
 * Where the air is both moist and cloudy, a soft white veil is composited; the
 * product RH·cloud keeps thin high cirrus from reading as thick storm cloud.
 */
function drawCloudVolume(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  data: CrossSectionData,
  rhGrid: FieldGrid,
  cloudGrid: FieldGrid,
): void {
  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  // Rasterise the cloud field to an offscreen buffer, one pixel per sample,
  // then scale it up with smoothing.
  //
  // The earlier per-band fill approach painted every cell separately, so
  // adjacent columns stacked their alpha and the whole slice washed out to
  // white. Writing a single alpha value per pixel composites each location
  // exactly once, which is what the field actually represents.
  const cols = Math.max(2, data.samples.length);
  const rows = Math.max(2, Math.round(plotH / 6));

  const buffer = ctx.createImageData(cols, rows);
  const px = buffer.data;

  for (let j = 0; j < rows; j += 1) {
    // j = 0 is the top of the plot (lowest pressure).
    const y = plotY + (j / (rows - 1)) * plotH;
    const p = pressureForYSection(y, layout);
    const rowPos = rowForPressure(p, data.levels);

    for (let i = 0; i < cols; i += 1) {
      const colPos = (i / Math.max(1, cols - 1)) * (rhGrid.cols - 1);

      const rh = sampleGrid(rhGrid, colPos, rowPos);
      const cloud = sampleGrid(cloudGrid, colPos, rowPos);

      // Humidity gate: dry air produces no cloud regardless of cloud cover.
      const rhWeight = Number.isFinite(rh) ? Math.max(0, (rh - 60) / 40) : 0;
      const cloudWeight = Number.isFinite(cloud) ? cloud / 100 : 0;
      const density = Math.max(0, Math.min(1, rhWeight * Math.sqrt(cloudWeight)));

      const o = (j * cols + i) * 4;
      // Slightly blue-tinted white reads as cloud; pure white looks like fog.
      px[o] = 226;
      px[o + 1] = 235;
      px[o + 2] = 246;
      px[o + 3] = Math.round(density * 120);
    }
  }

  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;
  offCtx.putImageData(buffer, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, plotX, plotY, plotW, plotH);
  ctx.restore();
}

/** Evenly spaced isotherms via marching squares on the temperature grid. */
function drawIsotherms(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  grid: FieldGrid,
  theme: SectionTheme,
): void {
  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  // Isotherm levels: every 10 °C, with 0 °C and -20 °C promoted.
  const candidates: number[] = [];
  const start = Math.ceil(grid.min / 10) * 10;
  for (let t = start; t <= grid.max; t += 10) candidates.push(t);

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();

  for (const level of candidates) {
    const isZero = level === 0;
    const isIce = level === -20;

    const contours = marchingSquares(grid, level);
    if (contours.length === 0) continue;

    ctx.strokeStyle = isZero ? theme.zeroIso : isIce ? theme.iceIso : 'rgba(226,232,240,0.22)';
    ctx.lineWidth = isZero ? 1.8 : isIce ? 1.4 : 1;
    if (isZero) ctx.setLineDash([6, 3]);
    else if (isIce) ctx.setLineDash([3, 3]);
    else ctx.setLineDash([]);

    for (const path of contours) {
      ctx.beginPath();
      for (let i = 0; i < path.length; i += 1) {
        const x = plotX + (path[i][0] / Math.max(1, grid.cols - 1)) * plotW;
        const y = plotY + (path[i][1] / Math.max(1, grid.rows - 1)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  ctx.setLineDash([]);

  // Labels for the two highlighted isotherms.
  for (const [level, label, color] of [
    [0, '0°C', theme.zeroIso],
    [-20, '-20°C', theme.iceIso],
  ] as [number, string, string][]) {
    const contours = marchingSquares(grid, level);
    const path = contours.sort((a, b) => b.length - a.length)[0];
    if (!path || path.length < 4) continue;

    const mid = path[Math.floor(path.length / 2)];
    const x = plotX + (mid[0] / Math.max(1, grid.cols - 1)) * plotW;
    const y = plotY + (mid[1] / Math.max(1, grid.rows - 1)) * plotH;

    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 3, y - 3);
  }

  ctx.restore();
}

/**
 * Marching squares.
 *
 * Returns polylines in grid-index space: each point is (col, row) with
 * fractional parts, which the callers convert to pixels. Closed loops come back
 * as closed polylines.
 */
export function marchingSquares(grid: FieldGrid, level: number): number[][][] {
  const { cols, rows, values } = grid;
  const paths: number[][][] = [];

  // Cache edge interpolations so adjacent cells reuse the same vertex.
  const edgeKey = (r: number, c: number, edge: number) => `${r},${c},${edge}`;

  interface Vtx {
    x: number;
    y: number;
  }

  const vtxCache = new Map<string, Vtx>();

  const edgeVertex = (r: number, c: number, edge: number): Vtx | null => {
    const key = edgeKey(r, c, edge);
    const cached = vtxCache.get(key);
    if (cached) return cached;

    // Corners: (c,r)=TL, (c+1,r)=TR, (c,r+1)=BL, (c+1,r+1)=BR
    const tl = values[r * cols + c];
    const tr = values[r * cols + c + 1];
    const bl = values[(r + 1) * cols + c];
    const br = values[(r + 1) * cols + c + 1];

    let v: Vtx | null = null;

    const lerp = (a: number, b: number) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
      const d = a - b;
      if (Math.abs(d) < 1e-9) return 0.5;
      return Math.max(0, Math.min(1, (a - level) / d));
    };

    switch (edge) {
      case 0: {
        // Top edge: TL -> TR
        if (!Number.isFinite(tl) || !Number.isFinite(tr)) return null;
        v = { x: c + lerp(tl, tr), y: r };
        break;
      }
      case 1: {
        // Right edge: TR -> BR
        if (!Number.isFinite(tr) || !Number.isFinite(br)) return null;
        v = { x: c + 1, y: r + lerp(tr, br) };
        break;
      }
      case 2: {
        // Bottom edge: BL -> BR
        if (!Number.isFinite(bl) || !Number.isFinite(br)) return null;
        v = { x: c + lerp(bl, br), y: r + 1 };
        break;
      }
      case 3: {
        // Left edge: TL -> BL
        if (!Number.isFinite(tl) || !Number.isFinite(bl)) return null;
        v = { x: c, y: r + lerp(tl, bl) };
        break;
      }
      default:
        break;
    }

    if (v) vtxCache.set(key, v);
    return v;
  };

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const tl = values[r * cols + c];
      const tr = values[r * cols + c + 1];
      const bl = values[(r + 1) * cols + c];
      const br = values[(r + 1) * cols + c + 1];

      if (
        !Number.isFinite(tl) ||
        !Number.isFinite(tr) ||
        !Number.isFinite(bl) ||
        !Number.isFinite(br)
      ) {
        continue;
      }

      // Case index: 8=TL, 4=TR, 2=BR, 1=BL
      let idx = 0;
      if (tl >= level) idx |= 8;
      if (tr >= level) idx |= 4;
      if (br >= level) idx |= 2;
      if (bl >= level) idx |= 1;

      if (idx === 0 || idx === 15) continue;

      const seg: Vtx[] = [];

      const push = (edge: number) => {
        const v = edgeVertex(r, c, edge);
        if (v) seg.push(v);
      };

      // Standard marching-squares case table.
      switch (idx) {
        case 1:
        case 14:
          push(2);
          push(3);
          break;
        case 2:
        case 13:
          push(1);
          push(2);
          break;
        case 3:
        case 12:
          push(1);
          push(3);
          break;
        case 4:
        case 11:
          push(0);
          push(1);
          break;
        case 6:
        case 9:
          push(0);
          push(2);
          break;
        case 7:
        case 8:
          push(0);
          push(3);
          break;
        case 5:
        case 10: {
          // Ambiguous saddle. Resolve with the cell-centre average: if the
          // centre is "inside", the two arcs bend away from it, otherwise
          // toward it. Marching squares emits two disjoint segments here.
          const centre = (tl + tr + bl + br) / 4;
          const centreInside = centre >= level;

          // idx 5 = TL+BL inside (left column); idx 10 = TR+BR inside.
          const pairs: [number, number][] =
            idx === 5
              ? centreInside
                ? [[0, 1], [2, 3]]
                : [[0, 3], [1, 2]]
              : centreInside
                ? [[0, 3], [1, 2]]
                : [[0, 1], [2, 3]];

          for (const [ea, eb] of pairs) {
            const va = edgeVertex(r, c, ea);
            const vb = edgeVertex(r, c, eb);
            if (va && vb) {
              paths.push([
                [va.x, va.y],
                [vb.x, vb.y],
              ]);
            }
          }
          continue;
        }
        default:
          break;
      }

      if (seg.length === 2) {
        paths.push(seg.map((p) => [p.x, p.y]));
      }
    }
  }

  return paths;
}

/** Jet streaks: outline regions where wind exceeds 30 m/s, glow the core. */
function drawJetStreaks(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  grid: FieldGrid,
  theme: SectionTheme,
): void {
  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();

  // Two nested contours convey intensity without a continuous colour wash.
  for (const [threshold, color, width] of [
    [30, theme.jet, 1.5],
    [45, theme.jetCore, 2.2],
  ] as [number, string, number][]) {
    if (grid.max < threshold) continue;

    const contours = marchingSquares(grid, threshold);
    if (contours.length === 0) continue;

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowBlur = threshold > 40 ? 8 : 4;
    ctx.shadowColor = color;

    for (const path of contours) {
      ctx.beginPath();
      for (let i = 0; i < path.length; i += 1) {
        const x = plotX + (path[i][0] / Math.max(1, grid.cols - 1)) * plotW;
        const y = plotY + (path[i][1] / Math.max(1, grid.rows - 1)) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

/**
 * Circulation arrows.
 *
 * Each arrow combines the along-section wind (horizontal component) with the
 * vertical velocity (vertical component). Omega is in Pa/s and negative means
 * ascent, so the sign is flipped when mapping onto screen Y.
 */
function drawCirculation(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  data: CrossSectionData,
  theme: SectionTheme,
): void {
  const plotX = layout.padding.left;
  const plotY = layout.padding.top;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const plotH = layout.height - layout.padding.top - layout.padding.bottom;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();

  const cols = data.samples.length;
  const rows = data.levels.length;

  // Subsample so the field reads as a vector field, not a thicket.
  const colStep = Math.max(1, Math.round(cols / 14));
  const rowStep = Math.max(1, Math.round(rows / 9));

  let maxHoriz = 1;
  for (const s of data.samples) {
    for (const v of s.tangentWind) {
      if (Number.isFinite(v)) maxHoriz = Math.max(maxHoriz, Math.abs(v));
    }
  }

  for (let r = 0; r < rows; r += rowStep) {
    const p = data.levels[r];
    const y = yForPressureSection(p, layout);

    for (let c = 0; c < cols; c += colStep) {
      const sample = data.samples[c];
      const x = plotX + (c / Math.max(1, cols - 1)) * plotW;

      const horiz = sample.tangentWind[r];
      const omega = sample.verticalVelocity[r];

      if (!Number.isFinite(horiz) && !Number.isFinite(omega)) continue;

      // Horizontal component scaled to a visible arrow length.
      const dx = Number.isFinite(horiz) ? (horiz / maxHoriz) * 16 : 0;

      // Vertical: omega < 0 = ascent = upward on screen.
      const omegaClamped = Number.isFinite(omega) ? Math.max(-2, Math.min(2, omega)) : 0;
      const dy = -omegaClamped * 9;

      const magnitude = Math.hypot(dx, dy);
      if (magnitude < 2) continue;

      const color =
        dy < -0.5 ? theme.arrowUp : dy > 0.5 ? theme.arrowDown : theme.arrow;

      drawArrow(ctx, x, y, x + dx, y + dy, color, Math.min(1.6, 0.7 + magnitude / 22));
    }
  }

  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  width: number,
): void {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = 4.2;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - head * Math.cos(angle - Math.PI / 7),
    y1 - head * Math.sin(angle - Math.PI / 7),
  );
  ctx.lineTo(
    x1 - head * Math.cos(angle + Math.PI / 7),
    y1 - head * Math.sin(angle + Math.PI / 7),
  );
  ctx.closePath();
  ctx.fill();
}

/* ------------------------------------------------------------------ */
/* Chrome                                                             */
/* ------------------------------------------------------------------ */

function drawSectionAxes(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  data: CrossSectionData,
  theme: SectionTheme,
): void {
  const plotLeft = layout.padding.left;
  const plotRight = layout.width - layout.padding.right;
  const plotTop = layout.padding.top;
  const plotBottom = layout.height - layout.padding.bottom;

  ctx.font = '9px ui-monospace, monospace';
  ctx.fillStyle = theme.textDim;
  ctx.textBaseline = 'middle';

  // Pressure ticks on the left.
  ctx.textAlign = 'right';
  for (const p of [1000, 850, 700, 500, 400, 300, 250, 200, 150, 100]) {
    if (p > layout.pBottom || p < layout.pTop) continue;
    const y = yForPressureSection(p, layout);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(String(p), plotLeft - 5, y);
  }

  // Altitude ticks on the right.
  ctx.textAlign = 'left';
  for (const p of [1000, 700, 500, 300, 200, 100]) {
    if (p > layout.pBottom || p < layout.pTop) continue;
    const y = yForPressureSection(p, layout);
    const km = (44330 * (1 - Math.pow(p / 1013.25, 0.1903))) / 1000;
    ctx.fillText(`${km.toFixed(0)}km`, plotRight + 5, y);
  }

  // Distance ticks along the bottom.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const total = data.lengthKm;
  const ticks = 6;
  for (let i = 0; i <= ticks; i += 1) {
    const t = i / ticks;
    const x = plotLeft + t * (plotRight - plotLeft);
    ctx.fillText(`${(t * total).toFixed(0)}`, x, plotBottom + 6);
  }

  ctx.fillStyle = theme.textDim;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('沿线距离 km', (plotLeft + plotRight) / 2, layout.height - 12);

  ctx.save();
  ctx.translate(12, (plotTop + plotBottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('气压 hPa', 0, 0);
  ctx.restore();
}

function drawSectionFrame(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  theme: SectionTheme,
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

function drawHighlight(
  ctx: CanvasRenderingContext2D,
  layout: SectionLayout,
  data: CrossSectionData,
  index: number | null,
  theme: SectionTheme,
): void {
  if (index === null || index < 0 || index >= data.samples.length) return;

  const sample = data.samples[index];
  const plotX = layout.padding.left;
  const plotW = layout.width - layout.padding.left - layout.padding.right;
  const x = plotX + (index / Math.max(1, data.samples.length - 1)) * plotW;

  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x, layout.padding.top);
  ctx.lineTo(x, layout.height - layout.padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = theme.text;
  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(
    `${sample.distanceKm.toFixed(0)}km`,
    x,
    layout.padding.top - 4,
  );
}
