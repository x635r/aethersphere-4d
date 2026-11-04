/**
 * AetherMap — owns the MapLibre instance and bridges it to app state.
 *
 * The basemap is CARTO's official label-free Dark Matter style: its vector
 * sources, glyphs and layer ids are maintained by CARTO, so we restyle it
 * instead of hand-rolling a style that would rot when tile layers change.
 */

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { WindParticleLayer, PARTICLE_COUNT_DEFAULT } from '../layers/WindParticleLayer';
import { DayNightLayer } from '../layers/DayNightLayer';
import { useAppStore } from '../state/store';
import { sampleField } from '../data/sample';
import type { WeatherFieldSet } from '../core/types';
import { LEVEL_ALTITUDE_M } from '../core/levels';
import type { ToolMode } from '../hooks/useAnalysisTools';
import type { LngLatPoint } from '../data/sounding';
import {
  ensureSectionOverlay,
  updateSectionOverlay,
  removeSectionOverlay,
} from '../layers/sectionOverlay';
import {
  ensureRadarLayers,
  setRadarFrame,
  fadeRadarSlot,
  setRadarVisible,
  removeRadarLayers,
  updateChemLayer,
  setChemVisible,
  setChemOpacity,
  removeChemLayer,
} from '../layers/stage3Layers';
import type { ChemField, IvtField, RadarMetadata } from '../data/stage3';
import { renderIvtField } from '../render/ivtRenderer';
import {
  ensureHazardLayers,
  updateHazards,
  setHazardsVisible,
  removeHazardLayers,
  ensureAirportLayers,
  updateAirports,
  setAirportsVisible,
  removeAirportLayers,
  ensureFlightLayers,
  updateFlights,
  setFlightsVisible,
  removeFlightLayers,
  updateAuroraLayer,
  setAuroraVisible,
  removeAuroraLayer,
} from '../layers/stage4Layers';
import type {
  AirportObservation,
  AuroraGrid,
  FlightCollection,
  HazardCollection,
} from '../data/stage4';
import { buildAuroraRamp, renderAurora } from '../render/aurora';
import type { MapBounds } from '../hooks/useStage4';
import {
  ensureCycloneLayers,
  updateCycloneOverlay,
  updateVortex,
  setCycloneVisible,
  removeCycloneLayers,
  createVortex,
  advanceVortex,
} from '../layers/cycloneLayers';
import type { TrackPoint } from '../utils/cyclone';
import { rotationDirection } from '../utils/cyclone';

const CARTO_NOLABELS_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

/**
 * Deep-space hologram palette. Water is darker than land so continents read as
 * glowing plates rather than the other way round.
 */
const PALETTE: Record<string, { color: string; opacity: number; width?: number }> = {
  background: { color: '#030712', opacity: 1 },
  landcover: { color: '#0a1424', opacity: 1 },
  water: { color: '#01040c', opacity: 1 },
  water_shadow: { color: '#01040c', opacity: 0.4 },
  boundary_state: { color: '#22d3ee', opacity: 0.12, width: 0.5 },
  boundary_country_inner: { color: '#22d3ee', opacity: 0.3, width: 0.8 },
  boundary_country_outline: { color: '#67e8f9', opacity: 0.34, width: 0.8 },
};

/**
 * Recolour the CARTO layers in place with `setPaintProperty`.
 *
 * Repainting beats `map.setStyle(restyled)` here: setStyle tears the style down
 * and re-fires `load`, and doing that from a `load` handler risks never
 * settling. Setting individual paint properties is idempotent and instantaneous.
 */
function applyPalette(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    const override = PALETTE[layer.id];
    if (!override) continue;

    try {
      if (layer.type === 'background') {
        map.setPaintProperty(layer.id, 'background-color', override.color);
        map.setPaintProperty(layer.id, 'background-opacity', override.opacity);
      } else if (layer.type === 'fill') {
        map.setPaintProperty(layer.id, 'fill-color', override.color);
        map.setPaintProperty(layer.id, 'fill-opacity', override.opacity);
      } else if (layer.type === 'line') {
        map.setPaintProperty(layer.id, 'line-color', override.color);
        map.setPaintProperty(layer.id, 'line-opacity', override.opacity);
        if (override.width !== undefined) {
          map.setPaintProperty(layer.id, 'line-width', override.width);
        }
      }
    } catch {
      // A layer may not support every paint property; skip it silently.
    }
  }
}

export interface AetherMapProps {
  fieldSet: WeatherFieldSet | null;
  timeIndex: number;
  /** Active Stage 2 instrument; controls what a map click does. */
  toolMode?: ToolMode;
  /** Committed or in-progress cross-section nodes. */
  sectionNodes?: LngLatPoint[];
  /** True while the user is still clicking out the polyline. */
  sectionDrafting?: boolean;
  /** Point reported by the section panel's cursor. */
  sectionHighlight?: LngLatPoint | null;
  onSoundingRequest?: (point: LngLatPoint) => void;
  onSectionNode?: (point: LngLatPoint) => void;

  /* ---- Stage 3 layers ---- */
  radarMetadata?: RadarMetadata | null;
  radarFrameIndex?: number;
  radarVisible?: boolean;
  chemField?: ChemField | null;
  chemVisible?: boolean;
  chemOpacity?: number;
  ivtField?: IvtField | null;
  ivtVisible?: boolean;
  ivtOpacity?: number;

  /** Set while the model arena is open but has no point yet. */
  awaitingArenaPoint?: boolean;
  onArenaPoint?: (point: LngLatPoint) => void;

  /* ---- Stage 4 layers ---- */
  hazards?: HazardCollection | null;
  hazardsVisible?: boolean;
  airports?: AirportObservation[];
  airportsVisible?: boolean;
  flights?: FlightCollection | null;
  flightsVisible?: boolean;
  aurora?: AuroraGrid | null;
  auroraVisible?: boolean;
  auroraOpacity?: number;
  /** Reports viewport bounds changes so viewport-scoped fetches can refresh. */
  onBoundsChange?: (bounds: MapBounds) => void;
  /** Called when an airport marker is clicked. */
  onAirportClick?: (icao: string) => void;

  /* ---- Stage 5: cyclone ---- */
  cycloneTrack?: TrackPoint[];
  cycloneActiveIndex?: number;
  cycloneVisible?: boolean;
  cycloneShowRings?: boolean;
}

export function AetherMap({
  fieldSet,
  timeIndex,
  toolMode = 'probe',
  sectionNodes = [],
  sectionDrafting = false,
  sectionHighlight = null,
  onSoundingRequest,
  onSectionNode,
  radarMetadata = null,
  radarFrameIndex = 0,
  radarVisible = false,
  chemField = null,
  chemVisible = false,
  chemOpacity = 0.68,
  ivtField = null,
  ivtVisible = false,
  ivtOpacity = 0.75,
  awaitingArenaPoint = false,
  onArenaPoint,
  hazards = null,
  hazardsVisible = false,
  airports = [],
  airportsVisible = false,
  flights = null,
  flightsVisible = false,
  aurora = null,
  auroraVisible = false,
  auroraOpacity = 0.85,
  onBoundsChange,
  onAirportClick,
  cycloneTrack = [],
  cycloneActiveIndex = 0,
  cycloneVisible = false,
  cycloneShowRings = true,
}: AetherMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const windLayerRef = useRef<WindParticleLayer | null>(null);
  const nightLayerRef = useRef<DayNightLayer | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const projection = useAppStore((s) => s.projection);
  const heatVisible = useAppStore((s) => s.heatVisible);
  const streakVisible = useAppStore((s) => s.streakVisible);
  const terminatorVisible = useAppStore((s) => s.terminatorVisible);
  const heatOpacity = useAppStore((s) => s.heatOpacity);
  const streakOpacity = useAppStore((s) => s.streakOpacity);
  const particleCount = useAppStore((s) => s.particleCount);
  const times = useAppStore((s) => s.times);
  const setProbe = useAppStore((s) => s.setProbe);

  /* ---------------- create the map ---------------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: CARTO_NOLABELS_STYLE,
        center: [105, 28],
        zoom: 1.9,
        minZoom: 0.35,
        maxZoom: 12,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
        fadeDuration: 120,
      });
    } catch (error) {
      setMapError(
        error instanceof Error
          ? `地图初始化失败：${error.message}`
          : '地图初始化失败：当前浏览器可能不支持 WebGL2。',
      );
      return;
    }

    mapRef.current = map;

    map.on('error', (event) => {
      const message = event.error?.message ?? '';
      if (/webgl|context/i.test(message)) {
        setMapError(`渲染上下文异常：${message}`);
      } else {
        console.warn('[aether] map:', message);
      }
    });

    map.on('load', () => {
      applyPalette(map);

      try {
        map.setProjection({ type: 'globe' });
      } catch {
        useAppStore.getState().setProjection('mercator');
      }

      const night = new DayNightLayer();
      const wind = new WindParticleLayer({ particleCount: PARTICLE_COUNT_DEFAULT });

      if (!map.getLayer(night.id)) map.addLayer(night);
      if (!map.getLayer(wind.id)) map.addLayer(wind);

      nightLayerRef.current = night;
      windLayerRef.current = wind;

      // Drawing surface for the cross-section line and its nodes.
      try {
        ensureSectionOverlay(map);
      } catch (error) {
        console.warn('[aether] section overlay:', error);
      }

      setReady(true);
    });

    map.on('error', (event) => {
      const message = event.error?.message ?? '';
      if (/webgl|context/i.test(message)) {
        setMapError(`渲染上下文异常：${message}`);
      } else {
        console.warn('[aether] map:', message);
      }
    });

    return () => {
      windLayerRef.current = null;
      nightLayerRef.current = null;
      mapRef.current = null;
      setReady(false);
      try {
        removeSectionOverlay(map);
        removeRadarLayers(map);
        removeChemLayer(map);
        removeHazardLayers(map);
        removeAirportLayers(map);
        removeFlightLayers(map);
        removeAuroraLayer(map);
        removeCycloneLayers(map);
        if (map.getLayer('aether-ivt-layer')) map.removeLayer('aether-ivt-layer');
        if (map.getSource('aether-ivt')) map.removeSource('aether-ivt');
      } catch {
        /* map may already be torn down */
      }
      map.remove();
    };
    // map is created once; store values are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- projection ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      map.setProjection({ type: projection });
    } catch {
      useAppStore.getState().setProjection('mercator');
    }
  }, [projection, ready]);

  /* ---------------- data ---------------- */
  useEffect(() => {
    if (!ready || !fieldSet) return;
    windLayerRef.current?.setFieldSet(fieldSet);
  }, [fieldSet, ready]);

  /* ---------------- timeline ---------------- */
  useEffect(() => {
    if (!ready) return;
    windLayerRef.current?.setFrameIndex(timeIndex);
    const stamp = times[timeIndex];
    if (stamp) nightLayerRef.current?.setTime(stamp);
  }, [timeIndex, times, ready]);

  /* ---------------- toggles ---------------- */
  useEffect(() => {
    windLayerRef.current?.setHeatVisible(heatVisible);
  }, [heatVisible, ready]);

  useEffect(() => {
    windLayerRef.current?.setStreaksVisible(streakVisible);
  }, [streakVisible, ready]);

  useEffect(() => {
    nightLayerRef.current?.setVisible(terminatorVisible);
  }, [terminatorVisible, ready]);

  useEffect(() => {
    windLayerRef.current?.setHeatOpacity(heatOpacity);
  }, [heatOpacity, ready]);

  useEffect(() => {
    windLayerRef.current?.setStreakOpacity(streakOpacity);
  }, [streakOpacity, ready]);

  useEffect(() => {
    windLayerRef.current?.setParticleCount(particleCount);
  }, [particleCount, ready]);

  /* ---------------- Stage 2 tool interaction ---------------- */
  // Refs keep the map handlers stable while always seeing the latest mode and
  // callbacks; re-registering listeners on every render would thrash the map.
  const toolModeRef = useRef(toolMode);
  toolModeRef.current = toolMode;
  const soundingCbRef = useRef(onSoundingRequest);
  soundingCbRef.current = onSoundingRequest;
  const sectionCbRef = useRef(onSectionNode);
  sectionCbRef.current = onSectionNode;
  const arenaAwaitingRef = useRef(awaitingArenaPoint);
  arenaAwaitingRef.current = awaitingArenaPoint;
  const arenaCbRef = useRef(onArenaPoint);
  arenaCbRef.current = onArenaPoint;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      const { lng, lat } = event.lngLat;
      if (Math.abs(lat) > 87) return;

      const point = { lng, lat };

      // The arena asks for a point before any tool mode is involved, so it is
      // checked first.
      if (arenaAwaitingRef.current) {
        arenaCbRef.current?.(point);
        return;
      }

      const mode = toolModeRef.current;
      if (mode === 'probe') return;

      if (mode === 'sounding') {
        soundingCbRef.current?.(point);
      } else if (mode === 'section') {
        sectionCbRef.current?.(point);
      }
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
    };
  }, []);

  /* Pointer feedback: the crosshair only makes sense in probe mode. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.getCanvas().style.cursor =
        awaitingArenaPoint || toolMode !== 'probe' ? 'cell' : 'crosshair';
    } catch {
      /* canvas may not be ready */
    }
  }, [toolMode, awaitingArenaPoint]);

  /* ---------------- Stage 5: cyclone track, rings, vortex ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    try {
      ensureCycloneLayers(map);
      updateCycloneOverlay(map, {
        track: cycloneTrack,
        activeIndex: cycloneActiveIndex,
        showRings: cycloneShowRings,
      });
      setCycloneVisible(map, cycloneVisible);
    } catch (error) {
      console.warn('[aether] cyclone overlay:', error);
    }
  }, [cycloneTrack, cycloneActiveIndex, cycloneShowRings, cycloneVisible, ready]);

  /**
   * Vortex animation.
   *
   * The particle set is rebuilt only when the storm or its radius changes; the
   * per-frame work is then just advancing angles and pushing a FeatureCollection,
   * which keeps this well inside the frame budget.
   */
  const vortexRef = useRef<ReturnType<typeof createVortex> | null>(null);
  const vortexKeyRef = useRef('');
  const vortexRafRef = useRef(0);
  const vortexStartRef = useRef(performance.now());

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const active = cycloneTrack[Math.max(0, Math.min(cycloneTrack.length - 1, cycloneActiveIndex))];

    if (!cycloneVisible || !active || !Number.isFinite(active.lat)) {
      if (vortexRafRef.current) {
        cancelAnimationFrame(vortexRafRef.current);
        vortexRafRef.current = 0;
      }
      try {
        updateVortex(map, []);
      } catch {
        /* layer may be gone */
      }
      return;
    }

    const radiusNm = active.r34 && active.r34 > 0 ? active.r34 : 120;
    const key = `${active.lat.toFixed(2)}|${active.lng.toFixed(2)}|${radiusNm.toFixed(0)}`;

    if (vortexKeyRef.current !== key) {
      vortexKeyRef.current = key;
      vortexRef.current = createVortex({
        center: { lat: active.lat, lng: active.lng },
        radiusNm,
        spin: rotationDirection(active.lat),
        particleCount: 300,
        // Colour by intensity so a Cat 5 vortex reads hotter than a TS.
        color: active.windKt >= 137 ? '#f5d0fe' : active.windKt >= 96 ? '#fca5a5' : '#e2e8f0',
      });
      vortexStartRef.current = performance.now();
    }

    const particles = vortexRef.current;
    if (!particles) return;

    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const elapsed = (performance.now() - vortexStartRef.current) / 1000;

      try {
        const features = advanceVortex(
          particles,
          {
            center: { lat: active.lat, lng: active.lng },
            radiusNm,
            spin: rotationDirection(active.lat),
            color: active.windKt >= 137 ? '#f5d0fe' : active.windKt >= 96 ? '#fca5a5' : '#e2e8f0',
          },
          elapsed,
        );
        updateVortex(map, features);
      } catch {
        return;
      }

      vortexRafRef.current = requestAnimationFrame(tick);
    };

    vortexRafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (vortexRafRef.current) {
        cancelAnimationFrame(vortexRafRef.current);
        vortexRafRef.current = 0;
      }
    };
  }, [cycloneTrack, cycloneActiveIndex, cycloneVisible, ready]);

  /* ---------------- Stage 4: hazards ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !hazards) return;
    try {
      ensureHazardLayers(map);
      updateHazards(map, hazards);
    } catch (error) {
      console.warn('[aether] hazard layer:', error);
    }
  }, [hazards, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setHazardsVisible(map, hazardsVisible);
    } catch (error) {
      console.warn('[aether] hazard visibility:', error);
    }
  }, [hazardsVisible, ready]);

  /* ---------------- Stage 4: airports ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || airports.length === 0) return;
    try {
      ensureAirportLayers(map);
      updateAirports(map, airports);
    } catch (error) {
      console.warn('[aether] airport layer:', error);
    }
  }, [airports, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setAirportsVisible(map, airportsVisible);
    } catch (error) {
      console.warn('[aether] airport visibility:', error);
    }
  }, [airportsVisible, ready]);

  /* ---------------- Stage 4: flights ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flights) return;
    try {
      ensureFlightLayers(map);
      updateFlights(map, flights.flights);
    } catch (error) {
      console.warn('[aether] flight layer:', error);
    }
  }, [flights, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setFlightsVisible(map, flightsVisible);
    } catch (error) {
      console.warn('[aether] flight visibility:', error);
    }
  }, [flightsVisible, ready]);

  /* ---------------- Stage 4: aurora ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !aurora) return;

    try {
      if (!auroraVisible) {
        setAuroraVisible(map, false);
        return;
      }

      const ramp = buildAuroraRamp(aurora);

      // Rasterise at a resolution that preserves the oval shape without
      // uploading a 360x181 texture every frame.
      const width = aurora.cols;
      const height = aurora.rows;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderAurora({
        grid: aurora,
        context: ctx,
        rect: { x: 0, y: 0, width, height },
        ramp,
        opacity: 1,
        hemisphere: 'both',
      });

      updateAuroraLayer(map, canvas.toDataURL('image/png'), auroraOpacity);
      setAuroraVisible(map, true);
    } catch (error) {
      console.warn('[aether] aurora layer:', error);
    }
  }, [aurora, auroraVisible, auroraOpacity, ready]);

  /* ---------------- Stage 4: viewport bounds + airport clicks ---------------- */
  const boundsCbRef = useRef(onBoundsChange);
  boundsCbRef.current = onBoundsChange;
  const airportCbRef = useRef(onAirportClick);
  airportCbRef.current = onAirportClick;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const emitBounds = () => {
      try {
        // Under globe projection `getBounds()` is unreliable: it can report a
        // longitude span well over 360° (observed: west -45.7, east 255.7,
        // span 301°) because the sphere is being viewed with perspective. The
        // robust approach is to unproject the viewport corners and fit a
        // lon/lat box around them.
        const canvas = map.getCanvas();
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        const corners = [
          [0, 0],
          [w, 0],
          [0, h],
          [w, h],
          [w / 2, h / 2],
        ];

        let minLat = Number.POSITIVE_INFINITY;
        let maxLat = Number.NEGATIVE_INFINITY;

        // Collect longitudes on the unit circle to handle antimeridian wrap:
        // averaging raw degrees across ±180 produces a nonsensical midpoint.
        let sinSum = 0;
        let cosSum = 0;
        const lngs: number[] = [];

        for (const [x, y] of corners) {
          const ll = map.unproject([x, y]);
          const lng = ll.lng;
          const lat = ll.lat;
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;

          const rad = (lng * Math.PI) / 180;
          sinSum += Math.sin(rad);
          cosSum += Math.cos(rad);
          lngs.push(lng);
        }

        if (lngs.length === 0 || !Number.isFinite(minLat)) return;

        // If the corner longitudes span more than 180° the viewport contains a
        // pole, so treat the query as global rather than guessing a box.
        const sorted = [...lngs].sort((a, b) => a - b);
        // Index explicitly: the corner list has 5 entries, so `sorted[5]` would
        // be undefined and the span would silently become NaN.
        const rawSpan = sorted[sorted.length - 1] - sorted[0];

        const centerLng = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;

        let west: number;
        let east: number;

        if (rawSpan > 180) {
          // Pole in view (or a very wide globe): use a global box.
          west = -180;
          east = 180;
        } else {
          west = Math.max(-180, centerLng - rawSpan / 2);
          east = Math.min(180, centerLng + rawSpan / 2);
          if (east <= west) {
            west = -180;
            east = 180;
          }
        }

        boundsCbRef.current?.({
          west,
          south: Math.max(-85, minLat),
          east,
          north: Math.min(85, maxLat),
        });
      } catch {
        /* bounds unavailable during teardown */
      }
    };

    // Debounce: `moveend` fires per gesture, and AWC/OpenSky are rate limited.
    let timer = 0;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(emitBounds, 700);
    };

    map.on('moveend', onMoveEnd);
    emitBounds();

    // Airport hit-testing, registered on the layer rather than the whole map so
    // the probe/click handlers keep their existing behaviour.
    const handleAirportClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const icao = feature?.properties?.icao;
      if (typeof icao === 'string') airportCbRef.current?.(icao);
    };

    const handleAirportEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const handleAirportLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    const bindAirportEvents = () => {
      try {
        if (map.getLayer('aether-airport-layer')) {
          map.on('click', 'aether-airport-layer', handleAirportClick);
          map.on('mouseenter', 'aether-airport-layer', handleAirportEnter);
          map.on('mouseleave', 'aether-airport-layer', handleAirportLeave);
        }
      } catch {
        /* layer not present yet */
      }
    };

    bindAirportEvents();

    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
      try {
        map.off('click', 'aether-airport-layer', handleAirportClick);
        map.off('mouseenter', 'aether-airport-layer', handleAirportEnter);
        map.off('mouseleave', 'aether-airport-layer', handleAirportLeave);
      } catch {
        /* already removed */
      }
    };
  }, [ready, airports.length]);

  /* ---------------- Stage 3: radar ---------------- */
  const radarSlotRef = useRef<'a' | 'b'>('b');
  const radarReadyRef = useRef(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !radarMetadata) return;

    try {
      if (!radarReadyRef.current) {
        ensureRadarLayers(map, radarMetadata);
        radarReadyRef.current = true;
      }

      const frames = radarMetadata.past;
      if (frames.length === 0) return;

      const frame = frames[Math.min(Math.max(0, radarFrameIndex), frames.length - 1)];

      // Alternate between the two slots so the incoming frame can cross-fade
      // while the outgoing one is still fully opaque.
      const incoming: 'a' | 'b' = radarSlotRef.current === 'a' ? 'b' : 'a';
      const outgoing: 'a' | 'b' = radarSlotRef.current;

      // The outgoing slot never drops to exactly 0: MapLibre would treat the
      // layer as invisible and evict its tiles, so the next time that slot is
      // reused the frame would blank before its tiles reload.
      const IDLE_OPACITY = 0.004;

      setRadarFrame(map, incoming, radarMetadata, frame, IDLE_OPACITY);
      fadeRadarSlot(map, outgoing, IDLE_OPACITY, 300);
      fadeRadarSlot(map, incoming, 0.95, 300);

      radarSlotRef.current = incoming;
    } catch (error) {
      console.warn('[aether] radar layer:', error);
    }
  }, [radarMetadata, radarFrameIndex, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setRadarVisible(map, radarVisible);
    } catch (error) {
      console.warn('[aether] radar visibility:', error);
    }
  }, [radarVisible, ready]);

  /* ---------------- Stage 3: chemistry ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !chemField) return;
    try {
      updateChemLayer(map, chemField, chemOpacity);
    } catch (error) {
      console.warn('[aether] chem layer:', error);
    }
  }, [chemField, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setChemVisible(map, chemVisible);
    } catch (error) {
      console.warn('[aether] chem visibility:', error);
    }
  }, [chemVisible, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      setChemOpacity(map, chemOpacity);
    } catch (error) {
      console.warn('[aether] chem opacity:', error);
    }
  }, [chemOpacity, ready]);

  /* ---------------- Stage 3: IVT corridor ---------------- */
  // The IVT field is drawn as an `image` source so MapLibre warps it onto the
  // globe. Rasterising it to a data URL on every frame change keeps the code
  // small and the field is only 24x12, so the cost is negligible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const SOURCE = 'aether-ivt';
    const LAYER = 'aether-ivt-layer';

    try {
      if (!ivtField || !ivtVisible) {
        if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
        return;
      }

      const { cols, rows } = ivtField.grid;
      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderIvtField({
        field: ivtField,
        context: ctx,
        rect: { x: 0, y: 0, width: cols, height: rows },
        opacity: 1,
      });

      const dataUrl = canvas.toDataURL('image/png');

      const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
        [-180, 85],
        [180, 85],
        [180, -85],
        [-180, -85],
      ];

      const existing = map.getSource(SOURCE) as
        | { updateImage?: (o: { url: string }) => void }
        | undefined;

      if (existing?.updateImage) {
        existing.updateImage({ url: dataUrl });
      } else {
        if (!map.getSource(SOURCE)) {
          map.addSource(SOURCE, { type: 'image', url: dataUrl, coordinates });
        }
        if (!map.getLayer(LAYER)) {
          map.addLayer({
            id: LAYER,
            type: 'raster',
            source: SOURCE,
            paint: {
              'raster-opacity': ivtOpacity,
              'raster-opacity-transition': { duration: 260, delay: 0 },
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
            },
          });
        }
      }

      if (map.getLayer(LAYER)) {
        map.setLayoutProperty(LAYER, 'visibility', 'visible');
        map.setPaintProperty(LAYER, 'raster-opacity', ivtOpacity);
      }
    } catch (error) {
      console.warn('[aether] ivt layer:', error);
    }
  }, [ivtField, ivtVisible, ivtOpacity, ready]);

  /* ---------------- section overlay sync ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    try {
      updateSectionOverlay(map, {
        nodes: sectionNodes,
        drafting: sectionDrafting,
        highlight: sectionHighlight,
      });
    } catch (error) {
      console.warn('[aether] section overlay update:', error);
    }
  }, [sectionNodes, sectionDrafting, sectionHighlight, ready]);

  /* ---------------- crosshair probe ---------------- */
  const fieldRef = useRef(fieldSet);
  fieldRef.current = fieldSet;
  const timeIndexRef = useRef(timeIndex);
  timeIndexRef.current = timeIndex;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMove = (event: maplibregl.MapMouseEvent) => {
      const field = fieldRef.current;
      if (!field) {
        setProbe(null);
        return;
      }

      const { lng, lat } = event.lngLat;
      // Beyond ±87° the mercator grid has no samples worth reporting.
      if (Math.abs(lat) > 87) {
        setProbe(null);
        return;
      }

      const sample = sampleField(field, lng, lat, timeIndexRef.current);
      if (!sample) {
        setProbe(null);
        return;
      }

      setProbe({
        lng,
        lat,
        windSpeedMs: sample.speed,
        windDirection: sample.direction,
        scalarValue: sample.scalar,
        scalarId: field.scalarId,
        level: field.level,
        altitudeM: field.level === 'surface' ? 0 : (LEVEL_ALTITUDE_M[field.level] ?? null),
        utcMs: field.times[timeIndexRef.current] ?? Date.now(),
      });
    };

    const handleLeave = () => setProbe(null);

    map.on('mousemove', handleMove);
    map.on('mouseout', handleLeave);

    return () => {
      map.off('mousemove', handleMove);
      map.off('mouseout', handleLeave);
    };
  }, [setProbe]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />

      {/* Vignette + scanline wash, purely decorative. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 45%, transparent 38%, rgba(3,7,18,0.55) 100%)',
        }}
      />

      {mapError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85">
          <div className="hud-panel max-w-md rounded-xl p-6 text-center">
            <p className="text-sm font-medium text-rose-300">地图无法渲染</p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{mapError}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
