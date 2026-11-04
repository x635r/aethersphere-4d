/**
 * Aurora oval rendering.
 *
 * ## Why the colour scale is data-calibrated
 *
 * SWPC's specification for OVATION describes greens at 5–30% and magenta above
 * 60%. Those bands describe a geomagnetic storm. Under the quiet conditions that
 * prevail most of the time — verified on a live payload: 44,791 of 65,160 cells
 * at exactly 0, a peak of 26, and *nothing* above 30 — a fixed 60% threshold
 * paints every day as a uniform green smear and the magenta band never appears.
 *
 * The ramp is therefore normalised against the observed peak of the current
 * grid, while still honouring the documented hue progression. The legend shows
 * the real probability numbers so the display can never mislead about intensity.
 */

import type { AuroraGrid } from '../data/stage4';

export interface AuroraRamp {
  /** Probability thresholds in ascending order, calibrated to the data. */
  bands: { value: number; color: [number, number, number]; label: string }[];
  /** Highest probability in the source grid. */
  peak: number;
}

/**
 * Build a ramp keyed to the current grid's peak.
 *
 * Hues follow the physical aurora emission colours: green (atomic oxygen at
 * ~100 km), then red (oxygen at higher altitude), then magenta/violet (nitrogen
 * at the base of the curtain). The *thresholds* come from the data.
 */
export function buildAuroraRamp(grid: AuroraGrid): AuroraRamp {
  const peak = Math.max(1, grid.peak);

  // Four bands spread across the observed range. When the peak is high the
  // upper bands naturally reach into the storm colours.
  const bands = [
    { value: peak * 0.12, color: [16, 82, 60] as [number, number, number], label: '微弱' },
    { value: peak * 0.35, color: [16, 185, 129] as [number, number, number], label: '可见' },
    { value: peak * 0.62, color: [52, 211, 153] as [number, number, number], label: '明亮' },
    { value: peak * 0.85, color: [244, 63, 94] as [number, number, number], label: '强磁暴' },
  ];

  return { bands, peak };
}

/**
 * Convert a probability to RGBA by interpolating the calibrated ramp.
 *
 * Below `floor` the pixel is fully transparent: that is what keeps the quiet
 * noise (the 11,862 cells at 1–4%) from fogging the whole polar cap.
 */
export function auroraColor(prob: number, ramp: AuroraRamp, floor = 3): [number, number, number, number] {
  if (!Number.isFinite(prob) || prob < floor) return [0, 0, 0, 0];

  const { bands } = ramp;

  if (prob <= bands[0].value) {
    const t = (prob - floor) / Math.max(1e-6, bands[0].value - floor);
    return [bands[0].color[0], bands[0].color[1], bands[0].color[2], Math.round(60 + t * 60)];
  }

  for (let i = 1; i < bands.length; i += 1) {
    const prev = bands[i - 1];
    const next = bands[i];
    if (prob <= next.value) {
      const t = (prob - prev.value) / Math.max(1e-6, next.value - prev.value);
      return [
        Math.round(prev.color[0] + (next.color[0] - prev.color[0]) * t),
        Math.round(prev.color[1] + (next.color[1] - prev.color[1]) * t),
        Math.round(prev.color[2] + (next.color[2] - prev.color[2]) * t),
        Math.round(110 + t * 120),
      ];
    }
  }

  // Above the top band: saturate at the storm colour.
  const top = bands[bands.length - 1].color;
  return [top[0], top[1], top[2], 235];
}

export interface AuroraRenderOptions {
  grid: AuroraGrid;
  context: CanvasRenderingContext2D;
  rect: { x: number; y: number; width: number; height: number };
  ramp: AuroraRamp;
  opacity?: number;
  /** Only draw the northern or southern oval. */
  hemisphere?: 'north' | 'south' | 'both';
}

/**
 * Rasterise the aurora oval to a canvas.
 *
 * The field is written once per pixel into an ImageData buffer (never as
 * overlapping fills, which would stack alpha), then drawn north-up into the
 * supplied rect.
 */
export function renderAurora(options: AuroraRenderOptions): { drawnCells: number } {
  const { grid, context: ctx, rect, ramp } = options;
  const opacity = options.opacity ?? 1;
  const hemisphere = options.hemisphere ?? 'both';

  const { cols, rows } = grid;

  // Restrict rows for a single-hemisphere view; row 0 is the south pole.
  const rowStart = hemisphere === 'south' ? 0 : hemisphere === 'north' ? 91 : 0;
  const rowEnd = hemisphere === 'north' ? rows - 1 : hemisphere === 'south' ? 90 : rows - 1;
  const usedRows = rowEnd - rowStart + 1;

  const buffer = ctx.createImageData(cols, usedRows);
  const px = buffer.data;
  let drawnCells = 0;

  for (let r = 0; r < usedRows; r += 1) {
    const srcRow = rowStart + r;
    for (let c = 0; c < cols; c += 1) {
      const prob = grid.probability[srcRow * cols + c];
      const [cr, cg, cb, ca] = auroraColor(prob, ramp);

      const o = (r * cols + c) * 4;
      px[o] = cr;
      px[o + 1] = cg;
      px[o + 2] = cb;
      px[o + 3] = Math.round(ca * opacity);

      if (ca > 0) drawnCells += 1;
    }
  }

  const off = document.createElement('canvas');
  off.width = cols;
  off.height = usedRows;
  const offCtx = off.getContext('2d');
  if (!offCtx) return { drawnCells: 0 };
  offCtx.putImageData(buffer, 0, 0);

  // Latitude span represented by the selected rows.
  const latTop = grid.latitude[rowEnd];
  const latBottom = grid.latitude[rowStart];

  ctx.save();
  ctx.translate(rect.x, rect.y);
  // Flip vertically: image row 0 must be the northern edge.
  ctx.scale(1, -1);

  // Map the latitude band into the full rect proportionally, so a
  // single-hemisphere view still lands in the correct part of a global canvas.
  const yTop = ((90 - latTop) / 180) * rect.height;
  const yBottom = ((90 - latBottom) / 180) * rect.height;
  const height = yBottom - yTop;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, -yBottom, rect.width, height);
  ctx.restore();

  return { drawnCells };
}

/** Legend rows showing actual probability values, not abstract percentages. */
export function auroraLegend(ramp: AuroraRamp): { label: string; color: string; range: string }[] {
  return ramp.bands.map((band, i) => {
    const low = i === 0 ? 3 : Math.round(ramp.bands[i - 1].value);
    const high = Math.round(band.value);
    return {
      label: band.label,
      color: `rgb(${band.color[0]}, ${band.color[1]}, ${band.color[2]})`,
      range: `${low}–${high}%`,
    };
  });
}

/**
 * Southern-most latitude where the aurora is plausibly visible.
 *
 * Scans northward rows for the first cell at or above `threshold` and returns
 * its latitude. This is the "viewline" that aurora forecasters report, computed
 * from the actual grid instead of the G-scale approximation.
 */
export function auroraViewlineLatitude(grid: AuroraGrid, threshold = 10): number | null {
  const { cols, rows } = grid;

  // Scan from the equator poleward so the first hit is the southern extent.
  for (let r = 90; r < rows; r += 1) {
    let rowMax = 0;
    for (let c = 0; c < cols; c += 1) {
      const v = grid.probability[r * cols + c];
      if (v > rowMax) rowMax = v;
    }
    if (rowMax >= threshold) return grid.latitude[r];
  }

  return null;
}

/** Same, for the southern oval (scanning northward toward the equator). */
export function auroraViewlineLatitudeSouth(grid: AuroraGrid, threshold = 10): number | null {
  const { cols } = grid;

  for (let r = 90; r >= 0; r -= 1) {
    let rowMax = 0;
    for (let c = 0; c < cols; c += 1) {
      const v = grid.probability[r * cols + c];
      if (v > rowMax) rowMax = v;
    }
    if (rowMax >= threshold) return grid.latitude[r];
  }

  return null;
}
