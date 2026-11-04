/**
 * useStage4 — state and fetching for the aviation and space-weather panels.
 *
 * Notable behaviours:
 *  - METAR/PIREP/flights are viewport-scoped: they refresh when the map's bounds
 *    change meaningfully, not on a timer, because AWC rate-limits bbox queries
 *    and OpenSky allows only ~100 anonymous requests per 15 minutes.
 *  - Flights never auto-poll. The user drives refreshes.
 *  - Aurora and Kp are global and cheap, so they load on panel open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAuroraGrid,
  fetchFlights,
  fetchHazards,
  fetchKpSeries,
  fetchMetars,
  fetchPireps,
  type AirportObservation,
  type AuroraGrid,
  type FlightCollection,
  type HazardCollection,
  type KpSeries,
  type PirepReport,
} from '../data/stage4';

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Stage4Panels {
  aviation: boolean;
  space: boolean;
}

export interface UseStage4Args {
  bounds: MapBounds | null;
}

export interface UseStage4Result {
  /* panels */
  panels: Stage4Panels;
  openPanel: (which: keyof Stage4Panels) => void;
  closePanel: (which: keyof Stage4Panels) => void;

  /* hazards */
  hazards: HazardCollection | null;
  hazardsLoading: boolean;
  hazardsError: string | null;
  hazardsVisible: boolean;
  toggleHazards: () => void;
  retryHazards: () => void;

  /* airports */
  airports: AirportObservation[];
  airportsLoading: boolean;
  airportsError: string | null;
  airportsVisible: boolean;
  toggleAirports: () => void;
  retryAirports: () => void;

  /* pireps */
  pireps: PirepReport[];

  /* flights */
  flights: FlightCollection | null;
  flightsLoading: boolean;
  flightsError: string | null;
  flightsVisible: boolean;
  toggleFlights: () => void;
  refreshFlights: () => void;

  /* aurora */
  aurora: AuroraGrid | null;
  auroraLoading: boolean;
  auroraError: string | null;
  auroraVisible: boolean;
  toggleAurora: () => void;
  retryAurora: () => void;
  auroraOpacity: number;
  setAuroraOpacity: (v: number) => void;

  /* kp */
  kp: KpSeries | null;
  kpLoading: boolean;
  kpError: string | null;
  retryKp: () => void;
}

export function useStage4({ bounds }: UseStage4Args): UseStage4Result {
  const [panels, setPanels] = useState<Stage4Panels>({ aviation: false, space: false });

  const openPanel = useCallback((which: keyof Stage4Panels) => {
    setPanels((p) => ({ ...p, [which]: true }));
  }, []);

  const closePanel = useCallback((which: keyof Stage4Panels) => {
    setPanels((p) => ({ ...p, [which]: false }));
  }, []);

  /* ---------------- hazards ---------------- */
  const [hazards, setHazards] = useState<HazardCollection | null>(null);
  const [hazardsLoading, setHazardsLoading] = useState(false);
  const [hazardsError, setHazardsError] = useState<string | null>(null);
  const [hazardsVisible, setHazardsVisible] = useState(true);

  const hazardAbort = useRef<AbortController | null>(null);
  const hazardRun = useRef(0);

  const loadHazards = useCallback(() => {
    const run = hazardRun.current + 1;
    hazardRun.current = run;

    hazardAbort.current?.abort();
    const controller = new AbortController();
    hazardAbort.current = controller;

    setHazardsLoading(true);
    setHazardsError(null);

    fetchHazards(controller.signal)
      .then((collection) => {
        if (run !== hazardRun.current) return;
        setHazards(collection);
        setHazardsLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== hazardRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setHazardsError(err instanceof Error ? err.message : 'SIGMET 获取失败');
        setHazardsLoading(false);
      });
  }, []);

  const toggleHazards = useCallback(() => setHazardsVisible((v) => !v), []);
  const retryHazards = useCallback(() => loadHazards(), [loadHazards]);

  useEffect(() => {
    if (panels.aviation && !hazards && !hazardsLoading && !hazardsError) loadHazards();
  }, [panels.aviation, hazards, hazardsLoading, hazardsError, loadHazards]);

  /* ---------------- airports ---------------- */

  const [airports, setAirports] = useState<AirportObservation[]>([]);
  const [airportsLoading, setAirportsLoading] = useState(false);
  const [airportsError, setAirportsError] = useState<string | null>(null);
  const [airportsVisible, setAirportsVisible] = useState(true);
  const [pireps, setPireps] = useState<PirepReport[]>([]);

  const airportAbort = useRef<AbortController | null>(null);
  const airportRun = useRef(0);
  const lastBoundsKey = useRef<string>('');

  const loadAirports = useCallback((bbox: MapBounds) => {
    const run = airportRun.current + 1;
    airportRun.current = run;

    airportAbort.current?.abort();
    const controller = new AbortController();
    airportAbort.current = controller;

    setAirportsLoading(true);
    setAirportsError(null);

    // METAR and PIREP share a bbox and are fetched together so the panel shows
    // a consistent snapshot.
    Promise.all([
      fetchMetars({ ...bbox, signal: controller.signal }),
      fetchPireps({ ...bbox, signal: controller.signal }).catch(() => [] as PirepReport[]),
    ])
      .then(([stations, reports]) => {
        if (run !== airportRun.current) return;
        setAirports(stations);
        setPireps(reports);
        setAirportsLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== airportRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setAirportsError(err instanceof Error ? err.message : 'METAR 获取失败');
        setAirportsLoading(false);
      });
  }, []);

  const toggleAirports = useCallback(() => setAirportsVisible((v) => !v), []);

  const retryAirports = useCallback(() => {
    if (bounds) loadAirports(bounds);
  }, [bounds, loadAirports]);

  // Reload when the viewport moves far enough to matter (whole-degree buckets).
  useEffect(() => {
    if (!panels.aviation || !bounds) return;

    const key = [bounds.west, bounds.south, bounds.east, bounds.north]
      .map((v) => Math.round(v))
      .join(',');

    if (key === lastBoundsKey.current) return;
    lastBoundsKey.current = key;
    loadAirports(bounds);
  }, [panels.aviation, bounds, loadAirports]);

  /* ---------------- flights ---------------- */
  const [flights, setFlights] = useState<FlightCollection | null>(null);
  const [flightsLoading, setFlightsLoading] = useState(false);
  const [flightsError, setFlightsError] = useState<string | null>(null);
  const [flightsVisible, setFlightsVisible] = useState(true);

  const flightAbort = useRef<AbortController | null>(null);
  const flightRun = useRef(0);

  const loadFlights = useCallback(
    (bbox: MapBounds | null, force = false) => {
      if (!bbox) return;

      const run = flightRun.current + 1;
      flightRun.current = run;

      flightAbort.current?.abort();
      const controller = new AbortController();
      flightAbort.current = controller;

      setFlightsLoading(true);
      setFlightsError(null);

      fetchFlights({ ...bbox, signal: controller.signal, force })
        .then((collection) => {
          if (run !== flightRun.current) return;
          setFlights(collection);
          setFlightsLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== flightRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          // OpenSky rate limits aggressively; surface the message rather than
          // retrying into a longer ban.
          setFlightsError(err instanceof Error ? err.message : '航班数据获取失败');
          setFlightsLoading(false);
        });
    },
    [],
  );

  const toggleFlights = useCallback(() => setFlightsVisible((v) => !v), []);

  const refreshFlights = useCallback(() => {
    loadFlights(bounds, true);
  }, [bounds, loadFlights]);

  // Flights are the most rate-limited upstream (OpenSky allows ~100 anonymous
  // requests per 15 min), so they are fetched on demand rather than on panel
  // open: the flight tab calls `refreshFlights` when the user actually looks at
  // it. Nothing polls. `loadFlights` also guards against re-entry while a
  // request is in flight.

  /* ---------------- aurora ---------------- */
  const [aurora, setAurora] = useState<AuroraGrid | null>(null);
  const [auroraLoading, setAuroraLoading] = useState(false);
  const [auroraError, setAuroraError] = useState<string | null>(null);
  const [auroraVisible, setAuroraVisible] = useState(true);
  const [auroraOpacity, setAuroraOpacity] = useState(0.85);

  const auroraAbort = useRef<AbortController | null>(null);
  const auroraRun = useRef(0);

  const loadAurora = useCallback(() => {
    const run = auroraRun.current + 1;
    auroraRun.current = run;

    auroraAbort.current?.abort();
    const controller = new AbortController();
    auroraAbort.current = controller;

    setAuroraLoading(true);
    setAuroraError(null);

    fetchAuroraGrid(controller.signal)
      .then((grid) => {
        if (run !== auroraRun.current) return;
        setAurora(grid);
        setAuroraLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== auroraRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setAuroraError(err instanceof Error ? err.message : '极光网格获取失败');
        setAuroraLoading(false);
      });
  }, []);

  const toggleAurora = useCallback(() => setAuroraVisible((v) => !v), []);
  const retryAurora = useCallback(() => loadAurora(), [loadAurora]);

  useEffect(() => {
    if (panels.space && !aurora && !auroraLoading && !auroraError) loadAurora();
  }, [panels.space, aurora, auroraLoading, auroraError, loadAurora]);

  /* ---------------- kp ---------------- */
  const [kp, setKp] = useState<KpSeries | null>(null);
  const [kpLoading, setKpLoading] = useState(false);
  const [kpError, setKpError] = useState<string | null>(null);

  const kpAbort = useRef<AbortController | null>(null);
  const kpRun = useRef(0);

  const loadKp = useCallback(() => {
    const run = kpRun.current + 1;
    kpRun.current = run;

    kpAbort.current?.abort();
    const controller = new AbortController();
    kpAbort.current = controller;

    setKpLoading(true);
    setKpError(null);

    fetchKpSeries(controller.signal)
      .then((series) => {
        if (run !== kpRun.current) return;
        setKp(series);
        setKpLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== kpRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setKpError(err instanceof Error ? err.message : 'Kp 指数获取失败');
        setKpLoading(false);
      });
  }, []);

  const retryKp = useCallback(() => loadKp(), [loadKp]);

  useEffect(() => {
    if (panels.space && !kp && !kpLoading && !kpError) loadKp();
  }, [panels.space, kp, kpLoading, kpError, loadKp]);

  /* cleanup */
  useEffect(
    () => () => {
      hazardAbort.current?.abort();
      airportAbort.current?.abort();
      flightAbort.current?.abort();
      auroraAbort.current?.abort();
      kpAbort.current?.abort();
    },
    [],
  );

  return {
    panels,
    openPanel,
    closePanel,

    hazards,
    hazardsLoading,
    hazardsError,
    hazardsVisible,
    toggleHazards,
    retryHazards,

    airports,
    airportsLoading,
    airportsError,
    airportsVisible,
    toggleAirports,
    retryAirports,

    pireps,

    flights,
    flightsLoading,
    flightsError,
    flightsVisible,
    toggleFlights,
    refreshFlights,

    aurora,
    auroraLoading,
    auroraError,
    auroraVisible,
    toggleAurora,
    retryAurora,
    auroraOpacity,
    setAuroraOpacity,

    kp,
    kpLoading,
    kpError,
    retryKp,
  };
}
