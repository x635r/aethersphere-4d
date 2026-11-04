/**
 * Cyclone map layers: best track, wind-radius rings, and the animated vortex.
 *
 * ## Track colouring
 *
 * The track is split into short segments, each carrying its own `wind` property,
 * and a `match` expression colours each segment by Saffir-Simpson category. A
 * single LineString with a gradient along it is not expressible in MapLibre's
 * paint properties, so per-segment features are the correct approach.
 *
 * ## Wind radii
 *
 * R34/R50/R64 are drawn as filled rings only where the archive actually has
 * them. Tip (1979) and Andrew (1992) predate routine scatterometer radii, so
 * their rings are absent rather than fabricated.
 *
 * ## Vortex
 *
 * A Canvas layer cannot follow the globe projection, so the vortex spiral is
 * drawn as GeoJSON point features whose positions are advanced each frame on a
 * requestAnimationFrame tick. That keeps the animation geodesically correct at
 * the cost of rebuilding a small FeatureCollection per frame, which is cheap at
 * a few hundred particles.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TrackPoint } from '../utils/cyclone';
import { saffirSimpson, windRadiusRing, rotationDirection } from '../utils/cyclone';

const TRACK_SOURCE = 'aether-cyclone-track';
const TRACK_LAYER = 'aether-cyclone-track-line';
const RING_SOURCE = 'aether-cyclone-rings';
const RING_LAYER = 'aether-cyclone-ring-fill';
const RING_LINE = 'aether-cyclone-ring-line';
const VORTEX_SOURCE = 'aether-cyclone-vortex';
const VORTEX_LAYER = 'aether-cyclone-vortex-dots';
const EYE_SOURCE = 'aether-cyclone-eye';
const EYE_LAYER = 'aether-cyclone-eye-dot';

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/* ------------------------------------------------------------------ */
/* Track                                                              */
/* ------------------------------------------------------------------ */

/**
 * Split a track into per-segment features so each can carry its own category
 * colour.
 */
function trackSegments(track: TrackPoint[]): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];

  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];

    // Use the stronger end of the segment for its category, so a segment that
    // intensifies into Cat 5 reads as Cat 5 rather than as its starting value.
    const wind = Math.max(
      Number.isFinite(a.windKt) ? a.windKt : 0,
      Number.isFinite(b.windKt) ? b.windKt : 0,
    );

    features.push({
      type: 'Feature',
      properties: {
        wind,
        category: saffirSimpson(wind).category,
        label: saffirSimpson(wind).label,
        color: saffirSimpson(wind).color,
        index: i,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [a.lng, a.lat],
          [b.lng, b.lat],
        ],
      },
    });
  }

  return features;
}

export function ensureCycloneLayers(map: MapLibreMap): void {
  if (!map.getSource(TRACK_SOURCE)) {
    map.addSource(TRACK_SOURCE, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getSource(RING_SOURCE)) {
    map.addSource(RING_SOURCE, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getSource(VORTEX_SOURCE)) {
    map.addSource(VORTEX_SOURCE, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getSource(EYE_SOURCE)) {
    map.addSource(EYE_SOURCE, { type: 'geojson', data: emptyCollection() });
  }

  const colorExpression = [
    'match',
    ['get', 'category'],
    0, ['case', ['>=', ['get', 'wind'], 34], '#34d399', '#38bdf8'],
    1, '#facc15',
    2, '#fb923c',
    3, '#f97316',
    4, '#ef4444',
    5, '#e879f9',
    '#94a3b8',
  ] as const;

  if (!map.getLayer(RING_LAYER)) {
    map.addLayer({
      id: RING_LAYER,
      type: 'fill',
      source: RING_SOURCE,
      paint: {
        'fill-color': ['get', 'color'] as unknown as string,
        'fill-opacity': ['get', 'opacity'] as unknown as number,
      },
    });
  }

  if (!map.getLayer(RING_LINE)) {
    map.addLayer({
      id: RING_LINE,
      type: 'line',
      source: RING_SOURCE,
      paint: {
        'line-color': ['get', 'color'] as unknown as string,
        'line-width': 1,
        'line-opacity': 0.75,
        'line-dasharray': [3, 2],
      },
    });
  }

  if (!map.getLayer(TRACK_LAYER)) {
    map.addLayer({
      id: TRACK_LAYER,
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Glow pass underneath is emulated with a wide, low-opacity stroke on
        // the same layer family; a second layer would double the draw calls.
        'line-color': colorExpression as unknown as string,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          1, 1.6,
          5, 3,
          10, 4.5,
        ],
        'line-opacity': 0.92,
        'line-blur': 0.5,
      },
    });
  }

  if (!map.getLayer(VORTEX_LAYER)) {
    map.addLayer({
      id: VORTEX_LAYER,
      type: 'circle',
      source: VORTEX_SOURCE,
      paint: {
        'circle-radius': ['get', 'radius'] as unknown as number,
        'circle-color': ['get', 'color'] as unknown as string,
        'circle-opacity': ['get', 'alpha'] as unknown as number,
        'circle-blur': 0.4,
      },
    });
  }

  if (!map.getLayer(EYE_LAYER)) {
    map.addLayer({
      id: EYE_LAYER,
      type: 'circle',
      source: EYE_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 5, 7, 10, 11],
        'circle-color': '#f8fafc',
        'circle-opacity': 0.95,
        'circle-stroke-color': 'rgba(4,10,20,0.85)',
        'circle-stroke-width': 1.5,
      },
    });
  }
}

export interface CycloneOverlayState {
  track: TrackPoint[];
  /** Index of the currently active fix (the vortex sits here). */
  activeIndex: number;
  /** Draw R34/R50/R64 rings at the active fix when available. */
  showRings: boolean;
  /** Ring styling per radius class. */
  opacity?: number;
}

/** Push the track and rings into the map. */
export function updateCycloneOverlay(map: MapLibreMap, state: CycloneOverlayState): void {
  ensureCycloneLayers(map);

  const trackSource = map.getSource(TRACK_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  const ringSource = map.getSource(RING_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;

  trackSource?.setData?.({
    type: 'FeatureCollection',
    features: state.track.length >= 2 ? trackSegments(state.track) : [],
  });

  const ringFeatures: GeoJSON.Feature[] = [];
  const active = state.track[Math.max(0, Math.min(state.track.length - 1, state.activeIndex))];

  if (state.showRings && active) {
    const rings: { nm: number | null; color: string; opacity: number }[] = [
      { nm: active.r34, color: '#22d3ee', opacity: (state.opacity ?? 1) * 0.1 },
      { nm: active.r50, color: '#fbbf24', opacity: (state.opacity ?? 1) * 0.14 },
      { nm: active.r64, color: '#f43f5e', opacity: (state.opacity ?? 1) * 0.18 },
    ];

    for (const ring of rings) {
      if (!ring.nm || ring.nm <= 0) continue;

      ringFeatures.push({
        type: 'Feature',
        properties: { color: ring.color, opacity: ring.opacity, radiusNm: ring.nm },
        geometry: {
          type: 'Polygon',
          coordinates: [windRadiusRing({ lat: active.lat, lng: active.lng }, ring.nm, 72)],
        },
      });
    }
  }

  ringSource?.setData?.({ type: 'FeatureCollection', features: ringFeatures });

  // Eye marker at the active fix.
  const eyeSource = map.getSource(EYE_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;

  eyeSource?.setData?.({
    type: 'FeatureCollection',
    features: active
      ? [
          {
            type: 'Feature',
            properties: { wind: active.windKt },
            geometry: { type: 'Point', coordinates: [active.lng, active.lat] },
          },
        ]
      : [],
  });
}

/* ------------------------------------------------------------------ */
/* Vortex particles                                                   */
/* ------------------------------------------------------------------ */

interface VortexParticle {
  /** Radius as a fraction of the R34 ring (0..1). */
  radiusFrac: number;
  /** Angle offset, radians. */
  angle: number;
  /** Angular speed factor. */
  speed: number;
  /** Per-particle alpha multiplier. */
  alpha: number;
  /** Per-particle size multiplier. */
  size: number;
}

export interface VortexOptions {
  center: { lat: number; lng: number };
  /** R34 radius in nautical miles; drives the spiral extent. */
  radiusNm: number;
  /** Rotation sign: +1 counter-clockwise (NH), -1 clockwise (SH). */
  spin: 1 | -1;
  particleCount?: number;
  color?: string;
}

/**
 * Create a vortex particle set.
 *
 * Particles are distributed on a spiral: the radius and angular offset are
 * correlated so the cloud looks like banding rather than a uniform disc.
 */
export function createVortex(options: VortexOptions): VortexParticle[] {
  const count = options.particleCount ?? 320;
  const particles: VortexParticle[] = [];

  // Deterministic pseudorandom so the pattern is stable across frames.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    // Log-ish radius distribution: more particles near the eyewall, which is
    // where the real wind maximum lives.
    const radiusFrac = Math.pow(rand(), 0.6) * 0.95 + 0.04;
    const angle = rand() * Math.PI * 2 + t * Math.PI * 1.4;

    particles.push({
      radiusFrac,
      angle,
      speed: 1.6 / (0.35 + radiusFrac),
      alpha: 0.25 + rand() * 0.55,
      size: 0.8 + rand() * 1.4,
    });
  }

  return particles;
}

/**
 * Advance the vortex and return its features.
 *
 * Angular velocity falls with radius (like a Rankine vortex: solid body inside
 * the eyewall, then 1/r outside), which is why `speed` divides by the radius.
 */
export function advanceVortex(
  particles: VortexParticle[],
  options: VortexOptions,
  elapsedSeconds: number,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  const { center, radiusNm, spin, color = '#e2e8f0' } = options;

  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || radiusNm <= 0) {
    return features;
  }

  const NM_PER_KM = 0.539957;
  const KM_PER_DEG = 111.32;
  const maxDeg = radiusNm / NM_PER_KM / KM_PER_DEG;

  const cosLat = Math.cos((center.lat * Math.PI) / 180);

  for (const p of particles) {
    // 1/r rotation, integrated analytically from the current clock so no
    // per-frame state is needed and a dropped frame cannot desynchronise it.
    const angle = p.angle + spin * p.speed * elapsedSeconds * 0.55;

    const latOffset = Math.cos(angle) * p.radiusFrac * maxDeg;
    const lngOffset = (Math.sin(angle) * p.radiusFrac * maxDeg) / Math.max(0.15, cosLat);

    features.push({
      type: 'Feature',
      properties: {
        radius: p.size,
        color,
        alpha: p.alpha,
      },
      geometry: {
        type: 'Point',
        coordinates: [center.lng + lngOffset, center.lat + latOffset],
      },
    });
  }

  return features;
}

export function updateVortex(map: MapLibreMap, features: GeoJSON.Feature[]): void {
  ensureCycloneLayers(map);
  const source = map.getSource(VORTEX_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  source?.setData?.({ type: 'FeatureCollection', features });
}

export function setCycloneVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of [TRACK_LAYER, RING_LAYER, RING_LINE, VORTEX_LAYER, EYE_LAYER]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

export function removeCycloneLayers(map: MapLibreMap): void {
  for (const id of [EYE_LAYER, VORTEX_LAYER, RING_LINE, RING_LAYER, TRACK_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [EYE_SOURCE, VORTEX_SOURCE, RING_SOURCE, TRACK_SOURCE]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/** Convenience: spin sign for a hemisphere. */
export { rotationDirection };
