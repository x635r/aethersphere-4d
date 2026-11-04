/**
 * Stage 4 map layers: aviation hazards, airport flight categories, live
 * flights, and the aurora oval.
 *
 * Design notes that matter:
 *
 *  - **SIGMET polygons** are rendered as fills plus outlines rather than true
 *    3D extrusions. MapLibre's `fill-extrusion` needs a height in metres and
 *    renders on a flat ground plane, which on a globe produces vertical slabs
 *    floating above the surface. A fill with a hazard-tinted outline plus the
 *    base/top altitudes in the panel communicates the same information without
 *    looking broken. The panel lists the vertical extent numerically.
 *
 *  - **Airport points** use a `circle` layer keyed on the AWC `fltcat` value, so
 *    colour comes straight from the authoritative field instead of being
 *    re-derived from ceiling and visibility.
 *
 *  - **Flights** are rotated triangles. MapLibre symbol layers auto-rotate icons
 *    with `icon-rotate` from a feature property, so the heading is data-driven.
 *
 *  - **Aurora** is a rasterised `image` source; MapLibre warps it onto the globe.
 */

import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import type {
  AirportObservation,
  FlightState,
  HazardCollection,
  HazardPolygon,
} from '../data/stage4';
import { FLIGHT_CATEGORY_STYLES, HAZARD_STYLES } from '../data/stage4';

/* ------------------------------------------------------------------ */
/* Layer / source identifiers                                          */
/* ------------------------------------------------------------------ */

const HAZARD_SOURCE = 'aether-hazard';
const HAZARD_FILL = 'aether-hazard-fill';
const HAZARD_LINE = 'aether-hazard-line';

const AIRPORT_SOURCE = 'aether-airport';
const AIRPORT_LAYER = 'aether-airport-layer';

const FLIGHT_SOURCE = 'aether-flight';
const FLIGHT_LAYER = 'aether-flight-layer';

const AURORA_SOURCE = 'aether-aurora';
const AURORA_LAYER = 'aether-aurora-layer';

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/* ------------------------------------------------------------------ */
/* Hazards                                                             */
/* ------------------------------------------------------------------ */

/** Build a Polygon feature for one hazard ring. */
function hazardFeature(hazard: HazardPolygon): GeoJSON.Feature {
  // A SIGMET with multiple rings becomes a MultiPolygon so MapLibre fills it as
  // one logical shape.
  const geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon =
    hazard.rings.length === 1
      ? { type: 'Polygon', coordinates: [hazard.rings[0]] }
      : { type: 'MultiPolygon', coordinates: hazard.rings.map((r) => [r]) };

  return {
    type: 'Feature',
    id: hazard.id,
    geometry,
    properties: {
      hazard: hazard.hazard,
      color: HAZARD_STYLES[hazard.hazard]?.color ?? '#94a3b8',
      firName: hazard.firName,
      qualifier: hazard.qualifier,
      base: hazard.base,
      top: hazard.top,
    },
  };
}

/**
 * Create the hazard layers once, then keep them updated via `setData`.
 *
 * The fill colour is a `match` expression on the hazard code so a single layer
 * handles every hazard class without duplicating layers per type.
 */
export function ensureHazardLayers(map: MapLibreMap): void {
  if (!map.getSource(HAZARD_SOURCE)) {
    map.addSource(HAZARD_SOURCE, { type: 'geojson', data: emptyCollection() });
  }

  const colorExpression = [
    'match',
    ['get', 'hazard'],
    'TS', HAZARD_STYLES.TS.color,
    'TURB', HAZARD_STYLES.TURB.color,
    'ICE', HAZARD_STYLES.ICE.color,
    'VA', HAZARD_STYLES.VA.color,
    'TC', HAZARD_STYLES.TC.color,
    'MTW', HAZARD_STYLES.MTW.color,
    '#94a3b8',
  ] as const;

  if (!map.getLayer(HAZARD_FILL)) {
    map.addLayer({
      id: HAZARD_FILL,
      type: 'fill',
      source: HAZARD_SOURCE,
      paint: {
        'fill-color': colorExpression as unknown as string,
        'fill-opacity': 0.18,
        'fill-outline-color': 'rgba(0,0,0,0)',
      },
    });
  }

  if (!map.getLayer(HAZARD_LINE)) {
    map.addLayer({
      id: HAZARD_LINE,
      type: 'line',
      source: HAZARD_SOURCE,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': colorExpression as unknown as string,
        'line-width': 1.4,
        'line-opacity': 0.85,
        'line-dasharray': [3, 2],
      },
    });
  }
}

export function updateHazards(map: MapLibreMap, hazards: HazardCollection): void {
  ensureHazardLayers(map);
  const source = map.getSource(HAZARD_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;

  if (source?.setData) {
    source.setData({
      type: 'FeatureCollection',
      features: hazards.hazards.map(hazardFeature),
    });
  }
}

export function setHazardsVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of [HAZARD_FILL, HAZARD_LINE]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

export function removeHazardLayers(map: MapLibreMap): void {
  for (const id of [HAZARD_LINE, HAZARD_FILL]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(HAZARD_SOURCE)) map.removeSource(HAZARD_SOURCE);
}

/* ------------------------------------------------------------------ */
/* Airports                                                            */
/* ------------------------------------------------------------------ */

function airportFeature(station: AirportObservation): GeoJSON.Feature {
  return {
    type: 'Feature',
    id: station.icao,
    geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
    properties: {
      icao: station.icao,
      site: station.site,
      category: station.category,
      windDir: station.windDir ?? -1,
      windSpeed: station.windSpeedKt ?? -1,
      gust: station.gustKt ?? -1,
      raw: station.raw,
    },
  };
}

export function ensureAirportLayers(map: MapLibreMap): void {
  if (!map.getSource(AIRPORT_SOURCE)) {
    map.addSource(AIRPORT_SOURCE, { type: 'geojson', data: emptyCollection() });
  }

  const colorExpression = [
    'match',
    ['get', 'category'],
    'VFR', FLIGHT_CATEGORY_STYLES.VFR.color,
    'MVFR', FLIGHT_CATEGORY_STYLES.MVFR.color,
    'IFR', FLIGHT_CATEGORY_STYLES.IFR.color,
    'LIFR', FLIGHT_CATEGORY_STYLES.LIFR.color,
    '#94a3b8',
  ] as const;

  if (!map.getLayer(AIRPORT_LAYER)) {
    map.addLayer({
      id: AIRPORT_LAYER,
      type: 'circle',
      source: AIRPORT_SOURCE,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2, 2.6,
          6, 4.5,
          10, 7,
        ],
        'circle-color': colorExpression as unknown as string,
        // A dark ring keeps the marker legible over bright weather layers.
        'circle-stroke-color': 'rgba(4,10,20,0.85)',
        'circle-stroke-width': 1,
        'circle-opacity': 0.92,
      },
    });
  }
}

export function updateAirports(map: MapLibreMap, stations: AirportObservation[]): void {
  ensureAirportLayers(map);
  const source = map.getSource(AIRPORT_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;

  source?.setData?.({
    type: 'FeatureCollection',
    features: stations.map(airportFeature),
  });
}

export function setAirportsVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(AIRPORT_LAYER)) {
    map.setLayoutProperty(AIRPORT_LAYER, 'visibility', visible ? 'visible' : 'none');
  }
}

export function removeAirportLayers(map: MapLibreMap): void {
  if (map.getLayer(AIRPORT_LAYER)) map.removeLayer(AIRPORT_LAYER);
  if (map.getSource(AIRPORT_SOURCE)) map.removeSource(AIRPORT_SOURCE);
}

/* ------------------------------------------------------------------ */
/* Flights                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the triangle icon used for aircraft.
 *
 * Generated once on a canvas so no external sprite sheet is needed: a filled
 * triangle pointing "up" (north), which `icon-rotate` then turns by the track.
 */
function buildAircraftIcon(): ImageData | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  // Nose at top centre, tail at bottom.
  ctx.moveTo(size / 2, 3);
  ctx.lineTo(size / 2 + 6.5, size - 4);
  ctx.lineTo(size / 2, size - 8);
  ctx.lineTo(size / 2 - 6.5, size - 4);
  ctx.closePath();

  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.strokeStyle = 'rgba(4,10,20,0.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

export function ensureFlightLayers(map: MapLibreMap): void {
  if (!map.hasImage('aether-aircraft')) {
    const icon = buildAircraftIcon();
    if (icon) {
      // `addImage` accepts ImageData in MapLibre v5.
      map.addImage('aether-aircraft', icon as unknown as ImageData);
    }
  }

  if (!map.getSource(FLIGHT_SOURCE)) {
    map.addSource(FLIGHT_SOURCE, { type: 'geojson', data: emptyCollection() });
  }

  if (!map.getLayer(FLIGHT_LAYER)) {
    map.addLayer({
      id: FLIGHT_LAYER,
      type: 'symbol',
      source: FLIGHT_SOURCE,
      layout: {
        'icon-image': 'aether-aircraft',
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2, 0.45,
          6, 0.7,
          10, 0.95,
        ],
        // Heading drives icon rotation, so the triangles point along track.
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': 0.9,
      },
    });
  }
}

function flightFeature(flight: FlightState): GeoJSON.Feature {
  return {
    type: 'Feature',
    id: flight.icao24,
    geometry: { type: 'Point', coordinates: [flight.lng, flight.lat] },
    properties: {
      callsign: flight.callsign,
      heading: flight.heading ?? 0,
      altitude: flight.altitudeM ?? 0,
      velocity: flight.velocityMs ?? 0,
      country: flight.country,
    },
  };
}

export function updateFlights(map: MapLibreMap, flights: FlightState[]): void {
  ensureFlightLayers(map);
  const source = map.getSource(FLIGHT_SOURCE) as
    | { setData?: (d: GeoJSON.FeatureCollection) => void }
    | undefined;

  source?.setData?.({
    type: 'FeatureCollection',
    features: flights.map(flightFeature),
  });
}

export function setFlightsVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(FLIGHT_LAYER)) {
    map.setLayoutProperty(FLIGHT_LAYER, 'visibility', visible ? 'visible' : 'none');
  }
}

export function removeFlightLayers(map: MapLibreMap): void {
  if (map.getLayer(FLIGHT_LAYER)) map.removeLayer(FLIGHT_LAYER);
  if (map.getSource(FLIGHT_SOURCE)) map.removeSource(FLIGHT_SOURCE);
}

/* ------------------------------------------------------------------ */
/* Aurora                                                              */
/* ------------------------------------------------------------------ */

/**
 * Install or update the aurora image layer.
 *
 * `dataUrl` comes from the calibrated renderer in `render/aurora.ts`; this
 * function only handles the MapLibre plumbing.
 */
export function updateAuroraLayer(
  map: MapLibreMap,
  dataUrl: string,
  opacity = 0.85,
): void {
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [-180, 90],
    [180, 90],
    [180, -90],
    [-180, -90],
  ];

  const source = map.getSource(AURORA_SOURCE) as ImageSource | undefined;

  if (source?.updateImage) {
    source.updateImage({ url: dataUrl });
  } else {
    if (!map.getSource(AURORA_SOURCE)) {
      map.addSource(AURORA_SOURCE, { type: 'image', url: dataUrl, coordinates });
    }
    if (!map.getLayer(AURORA_LAYER)) {
      map.addLayer({
        id: AURORA_LAYER,
        type: 'raster',
        source: AURORA_SOURCE,
        paint: {
          'raster-opacity': opacity,
          'raster-opacity-transition': { duration: 400, delay: 0 },
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
          // Aurora is an emission phenomenon: lifting brightness and saturation
          // makes it read as light on top of the weather field instead of as
          // another translucent layer blending with it.
          'raster-brightness-min': 0.06,
          'raster-brightness-max': 1.0,
          'raster-contrast': 0.28,
          'raster-saturation': 0.55,
        },
        // Aurora sits above the weather field but below the HUD.
        layout: { visibility: 'visible' },
      });
    }
  }

  if (map.getLayer(AURORA_LAYER)) {
    map.setPaintProperty(AURORA_LAYER, 'raster-opacity', opacity);
  }
}

export function setAuroraVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(AURORA_LAYER)) {
    map.setLayoutProperty(AURORA_LAYER, 'visibility', visible ? 'visible' : 'none');
  }
}

export function removeAuroraLayer(map: MapLibreMap): void {
  if (map.getLayer(AURORA_LAYER)) map.removeLayer(AURORA_LAYER);
  if (map.getSource(AURORA_SOURCE)) map.removeSource(AURORA_SOURCE);
}
