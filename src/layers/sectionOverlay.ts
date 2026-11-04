/**
 * A cross-section overlay drawn as a MapLibre GeoJSON layer.
 *
 * Kept as a GeoJSON source rather than a custom WebGL layer because the content
 * is a handful of lines and points — MapLibre handles the globe projection,
 * antialiasing and interaction for free, and there is no per-frame animation to
 * justify shader work.
 */

import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { LngLatPoint } from '../data/sounding';

const SOURCE_ID = 'aether-section-overlay';
const LAYER_LINE = 'aether-section-line';
const LAYER_NODE = 'aether-section-node';
const LAYER_HIGHLIGHT = 'aether-section-highlight';
const LAYER_DRAFT = 'aether-section-draft';

export interface SectionOverlayState {
  /** Committed transect nodes, or the in-progress draft. */
  nodes: LngLatPoint[];
  /** True while the user is still adding nodes. */
  drafting: boolean;
  /** The point currently highlighted by the section panel's cursor. */
  highlight: LngLatPoint | null;
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function lineFeature(coords: [number, number][], props: Record<string, unknown> = {}) {
  return {
    type: 'Feature' as const,
    properties: props,
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

function pointFeature(coord: [number, number], props: Record<string, unknown> = {}) {
  return {
    type: 'Feature' as const,
    properties: props,
    geometry: { type: 'Point' as const, coordinates: coord },
  };
}

/** Add the overlay sources and layers if they are absent. */
export function ensureSectionOverlay(map: MapLibreMap): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: emptyCollection() });
  }

  if (!map.getLayer(LAYER_DRAFT)) {
    map.addLayer({
      id: LAYER_DRAFT,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'draft'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fbbf24',
        'line-width': 2,
        'line-dasharray': [2, 1.6],
        'line-opacity': 0.95,
      },
    });
  }

  if (!map.getLayer(LAYER_LINE)) {
    map.addLayer({
      id: LAYER_LINE,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'section'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#e879f9',
        'line-width': 2.2,
        'line-opacity': 0.9,
        'line-blur': 0.6,
      },
    });
  }

  if (!map.getLayer(LAYER_NODE)) {
    map.addLayer({
      id: LAYER_NODE,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'node'],
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#0b1220',
        'circle-stroke-color': '#fbbf24',
        'circle-stroke-width': 2,
      },
    });
  }

  if (!map.getLayer(LAYER_HIGHLIGHT)) {
    map.addLayer({
      id: LAYER_HIGHLIGHT,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'highlight'],
      paint: {
        'circle-radius': 7,
        'circle-color': 'rgba(255,255,255,0.12)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }
}

/** Push the current overlay state into the map source. */
export function updateSectionOverlay(map: MapLibreMap, state: SectionOverlayState): void {
  const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;

  const features: GeoJSON.Feature[] = [];
  const coords = state.nodes.map((n) => [n.lng, n.lat] as [number, number]);

  if (coords.length >= 2) {
    features.push(
      lineFeature(coords, { kind: state.drafting ? 'draft' : 'section' }),
    );
  }

  for (const node of state.nodes) {
    features.push(pointFeature([node.lng, node.lat], { kind: 'node' }));
  }

  if (state.highlight) {
    features.push(
      pointFeature([state.highlight.lng, state.highlight.lat], { kind: 'highlight' }),
    );
  }

  source.setData({ type: 'FeatureCollection', features });
}

/** Remove the overlay layers and source (used on teardown). */
export function removeSectionOverlay(map: MapLibreMap): void {
  for (const id of [LAYER_HIGHLIGHT, LAYER_NODE, LAYER_LINE, LAYER_DRAFT]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
