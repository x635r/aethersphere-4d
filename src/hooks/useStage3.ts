/**
 * useStage3 — state and fetching for the Stage 3 instruments.
 *
 * Owns the three panels (model arena, atmospheric rivers, radar+chemistry) plus
 * the spaghetti view, and keeps the map layers in sync. Like the Stage 2 hook,
 * every fetch is cancellable and every panel has its own error slot so one
 * failing upstream cannot blank the others.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchModelArena,
  fetchSpaghetti,
  fetchIvtField,
  fetchRadarMetadata,
  fetchChemField,
  fetchChemPoint,
  type ArenaResult,
  type ArenaVariableId,
  type ChemField,
  type ChemPoint,
  type ChemVariableId,
  type IvtField,
  type RadarMetadata,
  type SpaghettiResult,
} from '../data/stage3';
import type { GridSpec } from '../core/types';
import { computeIvt } from '../utils/ivt';

/**
 * Globe grid for the IVT field.
 *
 * Atmospheric rivers are synoptic-scale features (hundreds of km wide), so an
 * 18x9 lattice (162 points) resolves them cleanly while leaving most of the
 * minute budget free for the Stage 1 grid. Going to 24x12 doubles the cost for
 * no visible gain in AR shape.
 */
export const IVT_GRID: GridSpec = { cols: 18, rows: 9 };

/**
 * Spaghetti grid. Contours need a little more resolution than the IVT field to
 * avoid jagged ridge lines, but 24x12 already costs 288 calls, so 22x11 (242) is
 * the compromise that keeps the lines smooth without dominating the budget.
 */
export const SPAGHETTI_GRID: GridSpec = { cols: 22, rows: 11 };

/** Chemistry is unmetered, so it can run slightly finer. */
export const CHEM_GRID: GridSpec = { cols: 36, rows: 18 };

export interface Stage3Panels {
  arena: boolean;
  rivers: boolean;
  radar: boolean;
  spaghetti: boolean;
}

export interface UseStage3Args {
  timeMs: number;
  /** Point currently under the probe, if any. */
  probePoint: { lat: number; lng: number } | null;
}

export interface UseStage3Result {
  /* ---- panel visibility ---- */
  panels: Stage3Panels;
  openPanel: (which: keyof Stage3Panels) => void;
  closePanel: (which: keyof Stage3Panels) => void;

  /* ---- arena ---- */
  arenaPoint: { lat: number; lng: number } | null;
  arena: ArenaResult | null;
  arenaLoading: boolean;
  arenaError: string | null;
  arenaVariable: ArenaVariableId;
  setArenaVariable: (v: ArenaVariableId) => void;
  arenaTimeIndex: number;
  setArenaTimeIndex: (i: number) => void;
  requestArena: (point: { lat: number; lng: number }) => void;
  retryArena: () => void;

  /* ---- spaghetti ---- */
  spaghetti: SpaghettiResult | null;
  spaghettiLoading: boolean;
  spaghettiError: string | null;
  retrySpaghetti: () => void;
  spaghettiVisible: boolean;
  toggleSpaghetti: () => void;

  /* ---- rivers ---- */
  ivt: IvtField | null;
  ivtLoading: boolean;
  ivtError: string | null;
  ivtVisible: boolean;
  ivtOpacity: number;
  setIvtOpacity: (v: number) => void;
  toggleIvt: () => void;
  retryIvt: () => void;
  probeIvt: { lat: number; lng: number; ivt: number } | null;

  /* ---- radar ---- */
  radar: RadarMetadata | null;
  radarLoading: boolean;
  radarError: string | null;
  radarFrameIndex: number;
  setRadarFrameIndex: (i: number) => void;
  radarPlaying: boolean;
  toggleRadarPlaying: () => void;
  radarVisible: boolean;
  toggleRadarVisible: () => void;
  retryRadar: () => void;

  /* ---- chemistry ---- */
  chemVariable: ChemVariableId;
  setChemVariable: (v: ChemVariableId) => void;
  chemField: ChemField | null;
  chemLoading: boolean;
  chemError: string | null;
  chemVisible: boolean;
  toggleChemVisible: () => void;
  chemOpacity: number;
  setChemOpacity: (v: number) => void;
  retryChem: () => void;
  chemPoint: ChemPoint | null;
}

export function useStage3({ timeMs, probePoint }: UseStage3Args): UseStage3Result {
  const [panels, setPanels] = useState<Stage3Panels>({
    arena: false,
    rivers: false,
    radar: false,
    spaghetti: false,
  });

  const openPanel = useCallback((which: keyof Stage3Panels) => {
    setPanels((p) => ({ ...p, [which]: true }));
  }, []);

  const closePanel = useCallback((which: keyof Stage3Panels) => {
    setPanels((p) => ({ ...p, [which]: false }));
  }, []);

  /* ---------------- arena ---------------- */
  const [arenaPoint, setArenaPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [arena, setArena] = useState<ArenaResult | null>(null);
  const [arenaLoading, setArenaLoading] = useState(false);
  const [arenaError, setArenaError] = useState<string | null>(null);
  const [arenaVariable, setArenaVariable] = useState<ArenaVariableId>('temperature_2m');
  const [arenaTimeIndex, setArenaTimeIndex] = useState(0);

  const arenaAbort = useRef<AbortController | null>(null);
  const arenaRun = useRef(0);

  const loadArena = useCallback(
    (point: { lat: number; lng: number }, variable: ArenaVariableId) => {
      const run = arenaRun.current + 1;
      arenaRun.current = run;

      arenaAbort.current?.abort();
      const controller = new AbortController();
      arenaAbort.current = controller;

      setArenaLoading(true);
      setArenaError(null);

      fetchModelArena({ lat: point.lat, lng: point.lng, variable, timeMs, signal: controller.signal })
        .then((result) => {
          if (run !== arenaRun.current) return;
          setArena(result);
          setArenaTimeIndex(0);
          setArenaLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== arenaRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setArenaError(err instanceof Error ? err.message : '多模型对比失败');
          setArenaLoading(false);
        });
    },
    [timeMs],
  );

  const requestArena = useCallback(
    (point: { lat: number; lng: number }) => {
      setArenaPoint(point);
      openPanel('arena');
      loadArena(point, arenaVariable);
    },
    [arenaVariable, loadArena, openPanel],
  );

  const retryArena = useCallback(() => {
    if (arenaPoint) loadArena(arenaPoint, arenaVariable);
  }, [arenaPoint, arenaVariable, loadArena]);

  // Re-fetch when the variable changes while the panel is open.
  const lastArenaVar = useRef(arenaVariable);
  useEffect(() => {
    if (lastArenaVar.current === arenaVariable) return;
    lastArenaVar.current = arenaVariable;
    if (panels.arena && arenaPoint) loadArena(arenaPoint, arenaVariable);
  }, [arenaVariable, panels.arena, arenaPoint, loadArena]);

  /* ---------------- spaghetti ---------------- */
  const [spaghetti, setSpaghetti] = useState<SpaghettiResult | null>(null);
  const [spaghettiLoading, setSpaghettiLoading] = useState(false);
  const [spaghettiError, setSpaghettiError] = useState<string | null>(null);
  const [spaghettiVisible, setSpaghettiVisible] = useState(false);

  const spaghettiAbort = useRef<AbortController | null>(null);
  const spaghettiRun = useRef(0);

  const loadSpaghetti = useCallback(() => {
    const run = spaghettiRun.current + 1;
    spaghettiRun.current = run;

    spaghettiAbort.current?.abort();
    const controller = new AbortController();
    spaghettiAbort.current = controller;

    setSpaghettiLoading(true);
    setSpaghettiError(null);

    fetchSpaghetti({ grid: SPAGHETTI_GRID, timeMs, signal: controller.signal })
      .then((result) => {
        if (run !== spaghettiRun.current) return;
        setSpaghetti(result);
        setSpaghettiLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== spaghettiRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setSpaghettiError(err instanceof Error ? err.message : '面条图获取失败');
        setSpaghettiLoading(false);
      });
  }, [timeMs]);

  const toggleSpaghetti = useCallback(() => {
    setSpaghettiVisible((v) => !v);
  }, []);

  const retrySpaghetti = useCallback(() => loadSpaghetti(), [loadSpaghetti]);

  // Fetch on first open.
  useEffect(() => {
    if (panels.spaghetti && !spaghetti && !spaghettiLoading && !spaghettiError) {
      loadSpaghetti();
    }
  }, [panels.spaghetti, spaghetti, spaghettiLoading, spaghettiError, loadSpaghetti]);

  /* ---------------- rivers / IVT ---------------- */
  const [ivt, setIvt] = useState<IvtField | null>(null);
  const [ivtLoading, setIvtLoading] = useState(false);
  const [ivtError, setIvtError] = useState<string | null>(null);
  const [ivtVisible, setIvtVisible] = useState(false);
  const [ivtOpacity, setIvtOpacity] = useState(0.75);

  const ivtAbort = useRef<AbortController | null>(null);
  const ivtRun = useRef(0);

  const loadIvt = useCallback(() => {
    const run = ivtRun.current + 1;
    ivtRun.current = run;

    ivtAbort.current?.abort();
    const controller = new AbortController();
    ivtAbort.current = controller;

    setIvtLoading(true);
    setIvtError(null);

    fetchIvtField({ grid: IVT_GRID, timeMs, signal: controller.signal })
      .then((field) => {
        if (run !== ivtRun.current) return;
        setIvt(field);
        setIvtLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== ivtRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setIvtError(err instanceof Error ? err.message : '水汽输送场获取失败');
        setIvtLoading(false);
      });
  }, [timeMs]);

  const toggleIvt = useCallback(() => setIvtVisible((v) => !v), []);
  const retryIvt = useCallback(() => loadIvt(), [loadIvt]);

  useEffect(() => {
    if (panels.rivers && !ivt && !ivtLoading && !ivtError) loadIvt();
  }, [panels.rivers, ivt, ivtLoading, ivtError, loadIvt]);

  /* ---------------- radar ---------------- */
  const [radar, setRadar] = useState<RadarMetadata | null>(null);
  const [radarLoading, setRadarLoading] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [radarFrameIndex, setRadarFrameIndex] = useState(0);
  const [radarPlaying, setRadarPlaying] = useState(true);
  const [radarVisible, setRadarVisible] = useState(true);

  const radarAbort = useRef<AbortController | null>(null);
  const radarRun = useRef(0);

  const loadRadar = useCallback(() => {
    const run = radarRun.current + 1;
    radarRun.current = run;

    radarAbort.current?.abort();
    const controller = new AbortController();
    radarAbort.current = controller;

    setRadarLoading(true);
    setRadarError(null);

    fetchRadarMetadata(controller.signal)
      .then((meta) => {
        if (run !== radarRun.current) return;
        setRadar(meta);
        setRadarFrameIndex(Math.max(0, meta.past.length - 1));
        setRadarLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== radarRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setRadarError(err instanceof Error ? err.message : '雷达元数据获取失败');
        setRadarLoading(false);
      });
  }, []);

  const toggleRadarPlaying = useCallback(() => setRadarPlaying((v) => !v), []);
  const toggleRadarVisible = useCallback(() => setRadarVisible((v) => !v), []);
  const retryRadar = useCallback(() => loadRadar(), [loadRadar]);

  useEffect(() => {
    if (panels.radar && !radar && !radarLoading && !radarError) loadRadar();
  }, [panels.radar, radar, radarLoading, radarError, loadRadar]);

  /* ---------------- chemistry ---------------- */
  const [chemVariable, setChemVariableState] = useState<ChemVariableId>('pm2_5');
  const [chemField, setChemField] = useState<ChemField | null>(null);
  const [chemLoading, setChemLoading] = useState(false);
  const [chemError, setChemError] = useState<string | null>(null);
  const [chemVisible, setChemVisible] = useState(false);
  const [chemOpacity, setChemOpacity] = useState(0.68);
  const [chemPoint, setChemPoint] = useState<ChemPoint | null>(null);

  const chemAbort = useRef<AbortController | null>(null);
  const chemRun = useRef(0);

  const loadChem = useCallback(
    (variable: ChemVariableId) => {
      const run = chemRun.current + 1;
      chemRun.current = run;

      chemAbort.current?.abort();
      const controller = new AbortController();
      chemAbort.current = controller;

      setChemLoading(true);
      setChemError(null);

      fetchChemField({ grid: CHEM_GRID, variable, timeMs, signal: controller.signal })
        .then((field) => {
          if (run !== chemRun.current) return;
          setChemField(field);
          setChemLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== chemRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setChemError(err instanceof Error ? err.message : '化学场获取失败');
          setChemLoading(false);
        });
    },
    [timeMs],
  );

  const setChemVariable = useCallback(
    (v: ChemVariableId) => {
      setChemVariableState(v);
      if (panels.radar) loadChem(v);
    },
    [panels.radar, loadChem],
  );

  const toggleChemVisible = useCallback(() => setChemVisible((v) => !v), []);
  const retryChem = useCallback(() => loadChem(chemVariable), [loadChem, chemVariable]);

  // Load the chem field the first time the radar panel opens.
  useEffect(() => {
    if (panels.radar && !chemField && !chemLoading && !chemError) loadChem(chemVariable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels.radar]);

  /* ---------------- probe-derived readouts ---------------- */

  // IVT at the probe point, interpolated from the field.
  const [probeIvt, setProbeIvt] = useState<{ lat: number; lng: number; ivt: number } | null>(null);

  useEffect(() => {
    if (!probePoint || !ivt) {
      setProbeIvt(null);
      return;
    }

    const { cols, rows } = ivt.grid;
    const x = ((probePoint.lng + 180) / 360) * cols - 0.5;
    const y = ((probePoint.lat + 85) / 170) * (rows - 1);

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    const wrap = (v: number) => ((v % cols) + cols) % cols;
    const clampI = (v: number) => (v < 0 ? 0 : v > rows - 1 ? rows - 1 : v);

    const c0 = wrap(x0);
    const c1 = wrap(x0 + 1);
    const r0 = clampI(y0);
    const r1 = clampI(y0 + 1);

    const v00 = ivt.values[r0 * cols + c0];
    const v10 = ivt.values[r0 * cols + c1];
    const v01 = ivt.values[r1 * cols + c0];
    const v11 = ivt.values[r1 * cols + c1];

    const finite = [v00, v10, v01, v11].filter(Number.isFinite);
    if (finite.length === 0) {
      setProbeIvt(null);
      return;
    }

    const avg =
      finite.length < 4
        ? finite.reduce((a, b) => a + b, 0) / finite.length
        : (() => {
            const top = v00 + (v10 - v00) * fx;
            const bottom = v01 + (v11 - v01) * fx;
            return top + (bottom - top) * fy;
          })();

    setProbeIvt({ lat: probePoint.lat, lng: probePoint.lng, ivt: avg });
  }, [probePoint, ivt]);

  // Point chemistry for the diagnostic card.
  const chemPointAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!panels.radar || !probePoint) {
      setChemPoint(null);
      return;
    }

    chemPointAbort.current?.abort();
    const controller = new AbortController();
    chemPointAbort.current = controller;

    // Debounce: the probe fires on every mousemove.
    const timer = window.setTimeout(() => {
      fetchChemPoint({
        lat: probePoint.lat,
        lng: probePoint.lng,
        timeMs,
        signal: controller.signal,
      })
        .then((point) => setChemPoint(point))
        .catch(() => {
          /* the field layer is still useful; the point card just stays empty */
        });
    }, 420);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [panels.radar, probePoint, timeMs]);

  /* Re-fetch everything time-dependent when the timeline moves. */
  const lastTime = useRef(timeMs);
  useEffect(() => {
    if (lastTime.current === timeMs) return;
    lastTime.current = timeMs;

    if (panels.arena && arenaPoint) loadArena(arenaPoint, arenaVariable);
    if (panels.spaghetti) loadSpaghetti();
    if (panels.rivers) loadIvt();
    if (panels.radar && chemField) loadChem(chemVariable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMs]);

  /* Cleanup on unmount. */
  useEffect(
    () => () => {
      arenaAbort.current?.abort();
      spaghettiAbort.current?.abort();
      ivtAbort.current?.abort();
      radarAbort.current?.abort();
      chemAbort.current?.abort();
      chemPointAbort.current?.abort();
    },
    [],
  );

  return {
    panels,
    openPanel,
    closePanel,

    arenaPoint,
    arena,
    arenaLoading,
    arenaError,
    arenaVariable,
    setArenaVariable,
    arenaTimeIndex,
    setArenaTimeIndex,
    requestArena,
    retryArena,

    spaghetti,
    spaghettiLoading,
    spaghettiError,
    retrySpaghetti,
    spaghettiVisible,
    toggleSpaghetti,

    ivt,
    ivtLoading,
    ivtError,
    ivtVisible,
    ivtOpacity,
    setIvtOpacity,
    toggleIvt,
    retryIvt,
    probeIvt,

    radar,
    radarLoading,
    radarError,
    radarFrameIndex,
    setRadarFrameIndex,
    radarPlaying,
    toggleRadarPlaying,
    radarVisible,
    toggleRadarVisible,
    retryRadar,

    chemVariable,
    setChemVariable,
    chemField,
    chemLoading,
    chemError,
    chemVisible,
    toggleChemVisible,
    chemOpacity,
    setChemOpacity,
    retryChem,
    chemPoint,
  };
}

/** Re-export for the panel that needs to classify a probe value. */
export { computeIvt };
