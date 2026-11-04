/**
 * Spaghetti-contour rendering for the 5880 gpm subtropical ridge.
 *
 * Each model's 500 hPa height field is contoured independently and the lines
 * are overlaid in that model's colour. Where the four lines bunch together the
 * supercomputers agree about the ridge position; where they fan apart, the
 * steering flow for typhoons — and therefore the track forecast — is uncertain.
 *
 * The renderer is projection-agnostic: callers supply a `project(lng, lat)`
 * callback, so the same code draws on a Mercator canvas or onto the globe.
 */

import { contours as extractContours } from '../utils/marchingSquares';
import { mercatorXFromLng, mercatorYFromLat } from '../core/geo';
import type { SpaghettiResult } from '../data/stage3';
import type { GridSpec } from '../core/types';

export interface SpaghettiProjection {
  /** Map lon/lat to canvas pixels. Returns null when the point is off-view. */
  project: (lng: number, lat: number) => { x: number; y: number } | null;
}

export interface SpaghettiTheme {
  ridgeGlow: string;
  label: string;
  background: string;
}

export const DEFAULT_SPAGHETTI_THEME: SpaghettiTheme = {
  /** Translucent plate drawn behind contour labels. */
  ridgeGlow: 'rgba(4,10,20,0.80)',
  label: '#e2e8f0',
  background: 'transparent',
};

export interface SpaghettiRenderOptions {
  result: SpaghettiResult;
  context: CanvasRenderingContext2D;
  projection: SpaghettiProjection;
  /** Draw the 5880 m ridge of every model. */
  showRidge?: boolean;
  /** Additional isohypses per model (e.g. 5700/5820/5940). */
  extraLevels?: number[];
  theme?: SpaghettiTheme;
  lineWidth?: number;
  /** Label each model's contour with its short name. */
  showLabels?: boolean;
}

export interface SpaghettiRenderStats {
  /** Number of ridge polylines drawn, per model. */
  ridgeCounts: Record<string, number>;
  /** Longitude span covered by the union of all ridges, degrees. */
  coverageLon: number;
  /** Largest gap between model ridge positions at a common latitude, degrees. */
  maxDisagreementDeg: number;
}

/**
 * Convert a grid cell index to lon/lat, matching `buildGridPoints` exactly:
 * latitude runs -85..+85 across rows, longitude -180..+180 across columns.
 */
function cellToLngLat(
  col: number,
  row: number,
  grid: GridSpec,
): { lng: number; lat: number } {
  const lng = -180 + (360 * col) / grid.cols;
  const lat = grid.rows === 1 ? 0 : -85 + (170 * row) / (grid.rows - 1);
  return { lng, lat };
}

/** Draw all model contours. Returns per-model statistics for the legend. */
export function renderSpaghetti(
  options: SpaghettiRenderOptions,
): SpaghettiRenderStats {
  const {
    result,
    context: ctx,
    projection,
    theme = DEFAULT_SPAGHETTI_THEME,
    lineWidth = 1.8,
  } = options;

  const showRidge = options.showRidge !== false;
  const extraLevels = options.extraLevels ?? [];

  // The theme supplies the label plate tint; resolved here so both the label
  // and the ridge glow stay in one palette.
  const labelPlate = theme.ridgeGlow;

  const { grid } = result;

  const ridgeCounts: Record<string, number> = {};
  let coverageLon = 0;
  let maxDisagreementDeg = 0;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const model of result.models) {
    // ---- faint secondary isohypses, so the flow structure is legible ----
    // They blend toward the theme's ridge tint so the eye still lands on the
    // 5880 m line rather than on the background isohypses.
    for (const level of extraLevels) {
      const paths = extractContours(model.values, grid.cols, grid.rows, level, 4);
      ctx.strokeStyle = withAlpha(model.color, 0.16);
      ctx.lineWidth = 0.8;

      for (const path of paths) {
        strokePath(ctx, path, grid, projection);
      }
    }

    // ---- the ridge line itself ----
    if (showRidge) {
      const paths = extractContours(
        model.values,
        grid.cols,
        grid.rows,
        result.contourLevel,
        4,
      );

      ridgeCounts[model.model] = paths.length;

      // Glow pass then core pass: two strokes read much better than a shadow,
      // and the glow borrows the theme tint so it sits in the chart palette.
      for (const lane of [
        { color: withAlpha(model.color, 0.28), width: lineWidth * 3.4 },
        { color: model.color, width: lineWidth },
      ]) {
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = lane.width;

        for (const path of paths) {
          strokePath(ctx, path, grid, projection);
        }
      }

      // Track the longitude span this ridge covers.
      let minLng = Number.POSITIVE_INFINITY;
      let maxLng = Number.NEGATIVE_INFINITY;
      for (const path of paths) {
        for (const pt of path) {
          const { lng } = cellToLngLat(pt.x, pt.y, grid);
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        }
      }
      if (Number.isFinite(minLng)) {
        coverageLon = Math.max(coverageLon, maxLng - minLng);
      }

      // ---- label placement ----
      if (options.showLabels !== false) {
        const longest = [...paths].sort((a, b) => b.length - a.length)[0];
        if (longest && longest.length > 6) {
          const mid = longest[Math.floor(longest.length / 2)];
          const { lng, lat } = cellToLngLat(mid.x, mid.y, grid);
          const p = projection.project(lng, lat);
          if (p) {
            // Plate behind the label so it survives crossing another model's line.
            // hue comes from the theme so the label never floats on a stray colour.
            ctx.font = '8px ui-monospace, monospace';
            const w = ctx.measureText(model.label).width;
            ctx.fillStyle = labelPlate;
            ctx.fillRect(p.x + 2, p.y - 13, w + 4, 12);

            ctx.fillStyle = model.color;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(model.label, p.x + 4, p.y - 7);
          }
        }
      }

      // ---- inter-model disagreement at the ridge latitude ----
      const disagreement = ridgeSpreadAtCommonLatitude(
        result,
        model.model,
      );
      maxDisagreementDeg = Math.max(maxDisagreementDeg, disagreement);
    }
  }

  ctx.restore();

  return { ridgeCounts, coverageLon, maxDisagreementDeg };
}

/** Stroke one stitched contour, splitting where it crosses the antimeridian. */
function strokePath(
  ctx: CanvasRenderingContext2D,
  path: { x: number; y: number }[],
  grid: GridSpec,
  projection: SpaghettiProjection,
): void {
  if (path.length < 2) return;

  ctx.beginPath();
  let prevLng: number | null = null;
  let drawing = false;

  for (const pt of path) {
    const { lng, lat } = cellToLngLat(pt.x, pt.y, grid);

    // A jump of more than 180° means the contour wrapped the antimeridian;
    // lifting the pen avoids a horizontal streak across the whole map.
    if (prevLng !== null && Math.abs(lng - prevLng) > 180) {
      drawing = false;
    }
    prevLng = lng;

    const p = projection.project(lng, lat);
    if (!p) {
      drawing = false;
      continue;
    }

    if (!drawing) {
      ctx.moveTo(p.x, p.y);
      drawing = true;
    } else {
      ctx.lineTo(p.x, p.y);
    }
  }

  ctx.stroke();
}

/**
 * How far apart the models place the ridge at a shared latitude.
 *
 * Sampling each model's contour at its mean latitude and comparing the mean
 * longitudes gives a single number the HUD can show: "models disagree by 12°".
 */
function ridgeSpreadAtCommonLatitude(
  result: SpaghettiResult,
  modelId: string,
): number {
  const { grid } = result;
  const positions: number[] = [];

  for (const model of result.models) {
    if (model.model === modelId) continue;

    const paths = extractContours(
      model.values,
      grid.cols,
      grid.rows,
      result.contourLevel,
      4,
    );

    let sumLng = 0;
    let count = 0;
    for (const path of paths) {
      for (const pt of path) {
        const { lng } = cellToLngLat(pt.x, pt.y, grid);
        sumLng += lng;
        count += 1;
      }
    }
    if (count > 0) positions.push(sumLng / count);
  }

  if (positions.length === 0) return 0;

  // Mean of the current model's ridge.
  const ownPaths = extractContours(
    result.models.find((m) => m.model === modelId)?.values ?? new Float32Array(),
    grid.cols,
    grid.rows,
    result.contourLevel,
    4,
  );

  let ownSum = 0;
  let ownCount = 0;
  for (const path of ownPaths) {
    for (const pt of path) {
      const { lng } = cellToLngLat(pt.x, pt.y, grid);
      ownSum += lng;
      ownCount += 1;
    }
  }
  if (ownCount === 0) return 0;

  const ownLng = ownSum / ownCount;
  return Math.max(...positions.map((p) => Math.abs(p - ownLng)));
}

/** Apply an alpha channel to a hex colour. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ------------------------------------------------------------------ */
/* Mercator projection for a full-globe canvas cover                  */
/* ------------------------------------------------------------------ */

/**
 * Build a projection that covers the whole globe inside an overlay rect.
 *
 * Used by the standalone "spaghetti map" view, where the contours are drawn on
 * their own canvas rather than over the 3D globe (the globe itself is drawn by
 * MapLibre, and an extra WebGL shader for four thin lines would be overkill).
 */
export function globeMercatorProjection(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): SpaghettiProjection {
  const yTop = mercatorYFromLat(85);
  const yBottom = mercatorYFromLat(-85);
  const ySpan = yBottom - yTop;

  return {
    project: (lng, lat) => {
      if (lat > 85 || lat < -85) return null;
      const mx = mercatorXFromLng(lng);
      const my = mercatorYFromLat(lat);
      return {
        x: rect.x + mx * rect.width,
        y: rect.y + ((my - yTop) / ySpan) * rect.height,
      };
    },
  };
}
