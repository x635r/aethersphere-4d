/**
 * MapLibre layers for Stage 3: Weather radar and CAMS chemistry.
 *
 * ## Radar
 *
 * RainViewer is served as raster tiles. Two independent MapLibre raster sources
 * are kept alive so consecutive frames can cross-fade: while frame N sits at
 * full opacity, frame N+1 fades in underneath/above via a paint transition.
 * A single source swapped per frame would flash black between frames.
 *
 * `maxzoom` is set to the API's native ceiling. RainViewer does not 404 above
 * z7 — it answers 200 with a differently-encoded placeholder image — so an
 * unclamped source silently turns the map grey instead of failing loudly.
 * Verified empirically: z6/z7 give 256x256 RGBA tiles, z8/z10 give RGB payloads
 * that are error images.
 *
 * ## Chemistry
 *
 * CAMS data arrives as a point grid rather than tiles, so it is rasterised to a
 * data URL and handed to an `image` source. `image` sources accept lon/lat
 * bounds and MapLibre projects them correctly under globe.
 */

import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import type { ChemField, ChemVariableId, RadarFrame, RadarMetadata } from '../data/stage3';
import { RADAR_MAX_NATIVE_ZOOM } from '../data/stage3';

const RADAR_SOURCE_A = 'aether-radar-a';
const RADAR_SOURCE_B = 'aether-radar-b';
const RADAR_LAYER_A = 'aether-radar-layer-a';
const RADAR_LAYER_B = 'aether-radar-layer-b';

const CHEM_SOURCE = 'aether-chem';
const CHEM_LAYER = 'aether-chem-layer';

/* ------------------------------------------------------------------ */
/* Radar                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create the two radar raster sources/layers once.
 *
 * Both start with opacity 0 so the layers exist (and can be re-pointed by URL
 * later) without drawing anything.
 */
export function ensureRadarLayers(map: MapLibreMap, metadata: RadarMetadata): void {
  // Seed with the newest past frame rather than a placeholder path: a bogus
  // template makes MapLibre fire tile errors before the first real frame lands.
  const seed = metadata.past[metadata.past.length - 1];
  const seedTemplate = seed
    ? `${metadata.host}${seed.path}/256/{z}/{x}/{y}/2/1_0.png`
    : 'https://tilecache.rainviewer.com/v2/radar/latest/256/{z}/{x}/{y}/2/1_0.png';

  for (const [sourceId, layerId] of [
    [RADAR_SOURCE_A, RADAR_LAYER_A],
    [RADAR_SOURCE_B, RADAR_LAYER_B],
  ] as const) {
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [seedTemplate],
        tileSize: 256,
        // Never request above the native ceiling; MapLibre over-zooms the z7
        // tile with GPU filtering instead.
        maxzoom: RADAR_MAX_NATIVE_ZOOM,
        minzoom: 0,
      });
    }

    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: 0 },
          'raster-fade-duration': 0,
          // RainViewer's scheme-2 tiles are linear-ish; slight contrast keeps
          // light drizzle visible over the dark basemap.
          'raster-contrast': 0.12,
          'raster-saturation': 0.25,
        },
      });
    }
  }
}

/**
 * Point one of the two radar slots at a frame and set its opacity.
 *
 * Re-assigning `tiles` on an existing source is the supported way to swap the
 * frame without tearing down the layer.
 */
export function setRadarFrame(
  map: MapLibreMap,
  slot: 'a' | 'b',
  metadata: RadarMetadata,
  frame: RadarFrame,
  opacity: number,
): void {
  const sourceId = slot === 'a' ? RADAR_SOURCE_A : RADAR_SOURCE_B;
  const layerId = slot === 'a' ? RADAR_LAYER_A : RADAR_LAYER_B;

  const tiles = [`${metadata.host}${frame.path}/256/{z}/{x}/{y}/2/1_0.png`];

  // `RasterTileSource` is not re-exported from maplibre-gl, so the method is
  // reached through a narrow structural type rather than `any`.
  const source = map.getSource(sourceId) as
    | { setTiles?: (t: string[]) => unknown }
    | undefined;

  if (source?.setTiles) {
    // Re-pointing the template reloads tiles without tearing down the layer,
    // which is what makes the cross-fade continuous.
    source.setTiles(tiles);
  } else {
    // Source missing (first call, or style was reset): (re)create both slots.
    ensureRadarLayers(map, metadata);
    const retry = map.getSource(sourceId) as
      | { setTiles?: (t: string[]) => unknown }
      | undefined;
    retry?.setTiles?.(tiles);
  }

  if (map.getLayer(layerId)) {
    // MapLibre only requests tiles for a layer whose opacity is non-zero: a
    // fully transparent raster is treated as invisible and its tile manager is
    // never marked as used. The incoming slot is therefore nudged to a tiny
    // non-zero opacity for one frame so its tiles start loading, and the fade
    // then raises it to the target.
    const loadingOpacity = opacity > 0 ? opacity : 0.004;
    map.setPaintProperty(layerId, 'raster-opacity', loadingOpacity);
  }
}

/** Fade one slot to a target opacity over `duration` ms. */
export function fadeRadarSlot(
  map: MapLibreMap,
  slot: 'a' | 'b',
  target: number,
  duration = 320,
): void {
  const layerId = slot === 'a' ? RADAR_LAYER_A : RADAR_LAYER_B;
  if (!map.getLayer(layerId)) return;

  map.setPaintProperty(layerId, 'raster-opacity-transition', { duration, delay: 0 });
  map.setPaintProperty(layerId, 'raster-opacity', target);
}

export function setRadarVisible(map: MapLibreMap, visible: boolean): void {
  for (const layerId of [RADAR_LAYER_A, RADAR_LAYER_B]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

export function removeRadarLayers(map: MapLibreMap): void {
  for (const layerId of [RADAR_LAYER_A, RADAR_LAYER_B]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [RADAR_SOURCE_A, RADAR_SOURCE_B]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
}

/* ------------------------------------------------------------------ */
/* Chemistry                                                          */
/* ------------------------------------------------------------------ */

/** Colour ramps per CAMS variable, chosen to match each quantity's semantics. */
const CHEM_RAMPS: Record<ChemVariableId, { stops: [number, [number, number, number, number]][] }> = {
  // PM2.5 — green to purple, the standard AQ ramp.
  pm2_5: {
    stops: [
      [0, [0, 0, 0, 0]],
      [5, [52, 211, 153, 40]],
      [15, [163, 230, 53, 95]],
      [35, [251, 191, 36, 140]],
      [55, [249, 115, 22, 175]],
      [90, [239, 68, 68, 200]],
      [150, [168, 85, 247, 220]],
    ],
  },
  // Dust — ochre/brown, dust storms read as earth tones, not as pollution greens.
  dust: {
    stops: [
      [0, [0, 0, 0, 0]],
      [10, [180, 140, 80, 45]],
      [50, [205, 160, 80, 110]],
      [150, [219, 170, 70, 160]],
      [400, [200, 130, 50, 195]],
      [900, [150, 90, 35, 215]],
    ],
  },
  // Aerosol optical depth — thin veil, so mostly opacity rather than hue.
  aerosol_optical_depth: {
    stops: [
      [0, [0, 0, 0, 0]],
      [0.1, [148, 163, 184, 40]],
      [0.3, [203, 213, 225, 90]],
      [0.6, [226, 232, 240, 140]],
      [1.2, [251, 191, 36, 170]],
      [2.5, [180, 83, 9, 200]],
    ],
  },
  // UV index — violet to red, matching the WHO colour scale.
  uv_index: {
    stops: [
      [0, [0, 0, 0, 0]],
      [2, [52, 211, 153, 50]],
      [5, [250, 204, 21, 110]],
      [7, [249, 115, 22, 150]],
      [10, [239, 68, 68, 190]],
      [14, [168, 85, 247, 215]],
    ],
  },
};

function sampleChemRamp(
  variable: ChemVariableId,
  value: number,
): [number, number, number, number] {
  const ramp = CHEM_RAMPS[variable];
  if (!Number.isFinite(value)) return [0, 0, 0, 0];

  const stops = ramp.stops;
  if (value <= stops[0][0]) return stops[0][1];

  for (let i = 1; i < stops.length; i += 1) {
    const [v0, c0] = stops[i - 1];
    const [v1, c1] = stops[i];
    if (value >= v0 && value <= v1) {
      const f = (value - v0) / (v1 - v0 || 1);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
        c0[3] + (c1[3] - c0[3]) * f,
      ];
    }
  }

  return stops[stops.length - 1][1];
}

/**
 * Rasterise a CAMS field into a data URL and install/update the image source.
 *
 * The `image` source takes explicit lon/lat corners, so no tile scheme or
 * projection handling is needed — MapLibre warps it onto the globe itself.
 */
export function updateChemLayer(
  map: MapLibreMap,
  field: ChemField,
  opacity = 0.7,
): void {
  const { cols, rows } = field.grid;

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = ctx.createImageData(cols, rows);
  const px = image.data;

  // The lattice stores row 0 as the southernmost sample, while an `image`
  // source's row 0 is its northern edge. Writing the rows in reverse keeps the
  // field north-up; without this the whole chemistry layer renders upside down.
  for (let r = 0; r < rows; r += 1) {
    const srcRow = rows - 1 - r;
    for (let c = 0; c < cols; c += 1) {
      const srcIndex = srcRow * cols + c;
      const dstIndex = r * cols + c;

      const v = field.values[srcIndex];
      const [cr, cg, cb, ca] = sampleChemRamp(field.variable, v);

      const o = dstIndex * 4;
      px[o] = cr;
      px[o + 1] = cg;
      px[o + 2] = cb;
      px[o + 3] = ca;
    }
  }

  ctx.putImageData(image, 0, 0);

  const dataUrl = canvas.toDataURL('image/png');

  // The lattice runs -85..+85 latitude, -180..+180 longitude.
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [-180, 85],
    [180, 85],
    [180, -85],
    [-180, -85],
  ];

  const source = map.getSource(CHEM_SOURCE) as ImageSource | undefined;

  if (source?.updateImage) {
    // Replacing the image in place avoids a source teardown each time step,
    // which would otherwise flash the layer off for a frame.
    source.updateImage({ url: dataUrl });
  } else {
    if (!map.getSource(CHEM_SOURCE)) {
      map.addSource(CHEM_SOURCE, { type: 'image', url: dataUrl, coordinates });
    }
    if (!map.getLayer(CHEM_LAYER)) {
      map.addLayer({
        id: CHEM_LAYER,
        type: 'raster',
        source: CHEM_SOURCE,
        paint: {
          'raster-opacity': opacity,
          'raster-opacity-transition': { duration: 260, delay: 0 },
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
        },
      });
    }
  }

  if (map.getLayer(CHEM_LAYER)) {
    map.setPaintProperty(CHEM_LAYER, 'raster-opacity', opacity);
  }
}

export function setChemVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(CHEM_LAYER)) {
    map.setLayoutProperty(CHEM_LAYER, 'visibility', visible ? 'visible' : 'none');
  }
}

export function setChemOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer(CHEM_LAYER)) {
    map.setPaintProperty(CHEM_LAYER, 'raster-opacity', opacity);
  }
}

export function removeChemLayer(map: MapLibreMap): void {
  if (map.getLayer(CHEM_LAYER)) map.removeLayer(CHEM_LAYER);
  if (map.getSource(CHEM_SOURCE)) map.removeSource(CHEM_SOURCE);
}

/** Legend rows for the active chemistry variable. */
export function chemLegendRows(variable: ChemVariableId): { value: number; color: string }[] {
  return CHEM_RAMPS[variable].stops
    .filter((s) => s[1][3] > 0)
    .map(([value, c]) => ({
      value,
      color: `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${(c[3] / 255).toFixed(2)})`,
    }));
}
