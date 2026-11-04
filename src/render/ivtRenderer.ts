/**
 * Atmospheric-river rendering.
 *
 * The IVT field is drawn as a glowing moisture corridor: a wide, low-alpha glow
 * underneath a narrow bright core, with the AR category bands (250/500/750/
 * 1000/1250 kg·m⁻¹·s⁻¹) stepping the hue from cyan through magenta.
 *
 * Two design constraints drove this:
 *
 *  1. The field is coarse (24x12 cells over the globe), so cells are bilinearly
 *     upsampled rather than drawn as flat blocks — otherwise an AR reads as a
 *     row of squares instead of a river.
 *  2. Alpha must be composited once per pixel. Painting per-cell produced
 *     overlapping alpha and washed the whole field out (the same fault that
 *     had to be fixed in the cross-section cloud layer).
 */

import type { IvtField } from '../data/stage3';
import { arCategoryInfo, type ArCategory } from '../utils/ivt';

export interface IvtRenderOptions {
  field: IvtField;
  context: CanvasRenderingContext2D;
  /** Canvas rect the globe occupies. */
  rect: { x: number; y: number; width: number; height: number };
  /** Pixels per degree of longitude at the equator (rect.width / 360). */
  pxPerLon?: number;
  /** Cells below this IVT are transparent. */
  minThreshold?: number;
  /** Draw only the AR cores (>= 250), hiding the background moisture. */
  arOnly?: boolean;
  opacity?: number;
}

export interface IvtRenderStats {
  maxIvt: number;
  arFraction: number;
  peakCategory: ArCategory;
  /** Category -> number of cells at that level. */
  categoryCounts: Record<number, number>;
}

/** Colour for a given IVT value, following the AR category palette. */
export function ivtColor(ivt: number): { r: number; g: number; b: number; a: number } {
  if (!Number.isFinite(ivt) || ivt < 50) return { r: 0, g: 0, b: 0, a: 0 };

  const category = (() => {
    if (ivt < 250) return 0;
    if (ivt < 500) return 1;
    if (ivt < 750) return 2;
    if (ivt < 1000) return 3;
    if (ivt < 1250) return 4;
    return 5;
  })() as ArCategory;

  // Below the AR threshold the field is a dim blue-teal "background moisture".
  if (category === 0) {
    const t = Math.min(1, (ivt - 50) / 200);
    return { r: 14 + t * 20, g: 90 + t * 100, b: 140 + t * 60, a: 30 + t * 55 };
  }

  const hex = arCategoryInfo(category).color;
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);

  // Higher categories are more opaque, so a Cat 5 core reads as solid while a
  // Cat 1 edge stays translucent enough to show the basemap beneath.
  const alpha = 120 + category * 24;

  return { r, g, b, a: Math.min(255, alpha) };
}

/**
 * Render the IVT field into the globe rect.
 *
 * Because the globe is a sphere, a plain lon/lat raster does not align with it.
 * The caller therefore supplies the rect and the field is drawn in equirect
 * layout; the covering MapLibre raster layer (see `IvtLayer`) is what actually
 * conforms it to the sphere. This function is used for the standalone 2D view
 * and for the legend swatch.
 */
export function renderIvtField(options: IvtRenderOptions): IvtRenderStats {
  const { field, context: ctx, rect } = options;
  const minThreshold = options.minThreshold ?? 50;
  const arOnly = options.arOnly ?? false;
  const opacity = options.opacity ?? 1;

  const { cols, rows } = field.grid;

  // Composite into an offscreen buffer at cell resolution, then upscale.
  const buffer = ctx.createImageData(cols, rows);
  const px = buffer.data;

  const categoryCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let arCells = 0;
  let peakCategory = 0;

  for (let i = 0; i < cols * rows; i += 1) {
    const ivt = field.values[i];
    const category = field.categories[i] as ArCategory;

    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    if (category > 0) arCells += 1;
    if (category > peakCategory) peakCategory = category;

    const o = i * 4;

    if (!Number.isFinite(ivt) || ivt < minThreshold || (arOnly && category === 0)) {
      px[o + 3] = 0;
      continue;
    }

    const color = ivtColor(ivt);
    px[o] = color.r;
    px[o + 1] = color.g;
    px[o + 2] = color.b;
    px[o + 3] = Math.round(color.a * opacity);
  }

  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const offCtx = off.getContext('2d');
  if (!offCtx) {
    return {
      maxIvt: field.max,
      arFraction: 0,
      peakCategory: peakCategory as ArCategory,
      categoryCounts,
    };
  }
  offCtx.putImageData(buffer, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Row 0 of the lattice is -85 (south), so the image is drawn north-up.
  ctx.translate(rect.x, rect.y);
  ctx.scale(1, -1);
  ctx.drawImage(off, 0, -rect.height, rect.width, rect.height);
  ctx.restore();

  const total = cols * rows;

  return {
    maxIvt: field.max,
    arFraction: total > 0 ? arCells / total : 0,
    peakCategory: peakCategory as ArCategory,
    categoryCounts,
  };
}

/** Legend rows for the AR categories, including the background moisture band. */
export function ivtLegendRows(): { label: string; color: string; range: string }[] {
  return [
    { label: '背景水汽', color: 'rgb(20, 120, 180)', range: '50–250' },
    ...([1, 2, 3, 4, 5] as ArCategory[]).map((cat) => {
      const info = arCategoryInfo(cat);
      const low = [250, 500, 750, 1000, 1250][cat - 1];
      const high = [500, 750, 1000, 1250, '∞'][cat - 1];
      return { label: info.label, color: info.color, range: `${low}–${high}` };
    }),
  ];
}
