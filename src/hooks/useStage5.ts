/**
 * useStage5 — state for the cyclone museum and climate time machine.
 *
 * Owns:
 *  - cyclone selection, per-storm time cursor, comparison membership,
 *  - IBTrACS file import (parsed, converted to a CycloneRecord, appended),
 *  - climate series/daily fetching tied to the probe location,
 *  - the vortex animation clock.
 *
 * The vortex is advanced by the map component on a rAF tick, not here, so the
 * particle field stays smooth while React re-renders for panel content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEGENDARY_CYCLONES,
} from '../data/legendaryCyclones';
import {
  buildCycloneSpec,
  decodeTrack,
  parseIbtracsGeoJson,
  type ComparisonMetric,
  type CycloneRecord,
  type CycloneSpec,
  type TrackPoint,
  type TrackTuple,
} from '../utils/cyclone';
import {
  computeStripes,
  fetchClimateSeries,
  fetchDailyRecord,
  HISTORICAL_EVENTS,
  type ClimateSeries,
  type DailyRecord,
  type StripeData,
} from '../data/climate';

export interface Stage5Panels {
  museum: boolean;
  climate: boolean;
}

export interface UseStage5Args {
  probe: { lat: number; lng: number } | null;
}

export interface UseStage5Result {
  panels: Stage5Panels;
  openPanel: (which: keyof Stage5Panels) => void;
  closePanel: (which: keyof Stage5Panels) => void;

  /* ---- museum ---- */
  records: CycloneRecord[];
  specs: CycloneSpec[];
  selectedId: string | null;
  selectCyclone: (id: string | null) => void;

  timeIndex: number;
  setTimeIndex: (i: number) => void;

  visible: boolean;
  toggleVisible: () => void;
  showRings: boolean;
  toggleRings: () => void;

  compareIds: string[];
  toggleCompare: (id: string) => void;
  comparisonMetric: ComparisonMetric;
  setComparisonMetric: (m: ComparisonMetric) => void;

  arenaPoint: { lat: number; lng: number } | null;
  setArenaPoint: (p: { lat: number; lng: number } | null) => void;

  /** Decoded track of the selected storm. */
  activeTrack: TrackPoint[];
  /** Fix currently under the time cursor. */
  activePoint: TrackPoint | null;

  importWarnings: string[];
  importError: string | null;
  importFile: (file: File) => void;

  /* ---- climate ---- */
  climatePoint: { lat: number; lng: number } | null;
  setClimatePoint: (p: { lat: number; lng: number } | null) => void;

  daily: DailyRecord | null;
  dailyLoading: boolean;
  dailyError: string | null;
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  retryDaily: () => void;
  jumpToEvent: (eventId: string) => void;

  series: ClimateSeries | null;
  stripes: StripeData | null;
  seriesLoading: boolean;
  seriesError: string | null;
  retrySeries: () => void;
  climateSpan: { from: number; to: number };
}

/** Whole ERA5 archive range we request. */
const CLIMATE_START_YEAR = 1940;
const CLIMATE_END_YEAR = 2025;

export function useStage5({ probe }: UseStage5Args): UseStage5Result {
  const [panels, setPanels] = useState<Stage5Panels>({ museum: false, climate: false });

  const openPanel = useCallback((which: keyof Stage5Panels) => {
    setPanels((p) => ({ ...p, [which]: true }));
  }, []);

  const closePanel = useCallback((which: keyof Stage5Panels) => {
    setPanels((p) => ({ ...p, [which]: false }));
  }, []);

  /* ---------------- museum ---------------- */

  const [imported, setImported] = useState<CycloneRecord[]>([]);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  const records = useMemo(() => [...LEGENDARY_CYCLONES, ...imported], [imported]);

  const specs = useMemo(() => records.map(buildCycloneSpec), [records]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeIndex, setTimeIndexRaw] = useState(0);
  const [visible, setVisible] = useState(true);
  const [showRings, setShowRings] = useState(true);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparisonMetric, setComparisonMetric] = useState<ComparisonMetric>('wind');
  const [arenaPoint, setArenaPoint] = useState<{ lat: number; lng: number } | null>(null);

  const activeTrack = useMemo(() => {
    const record = records.find((r) => r.id === selectedId);
    return record ? decodeTrack(record) : [];
  }, [records, selectedId]);

  // Reset the cursor when the selection changes so it never points past the new
  // track's end.
  useEffect(() => {
    setTimeIndexRaw(0);
  }, [selectedId]);

  const setTimeIndex = useCallback(
    (i: number) => {
      const max = Math.max(0, activeTrack.length - 1);
      setTimeIndexRaw(Math.max(0, Math.min(max, Math.round(i))));
    },
    [activeTrack.length],
  );

  const activePoint = activeTrack[timeIndex] ?? null;

  const toggleVisible = useCallback(() => setVisible((v) => !v), []);
  const toggleRings = useCallback(() => setShowRings((v) => !v), []);

  const toggleCompare = useCallback((id: string) => {
    setCompareIds((ids) => {
      if (ids.includes(id)) return ids.filter((x) => x !== id);
      // Four is the practical ceiling before the bars stop being readable.
      if (ids.length >= 4) return [...ids.slice(1), id];
      return [...ids, id];
    });
  }, []);

  const selectCyclone = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  /**
   * Import an IBTrACS file.
   *
   * The parsed track is converted into the same CycloneRecord shape the bundled
   * data uses, so every downstream consumer (map layer, arena, chart) works
   * unchanged. The imported record gets a synthetic id and is excluded from
   * persistence — it lives only for this session.
   */
  const importFile = useCallback((file: File) => {
    setImportError(null);
    setImportWarnings([]);

    const reader = new FileReader();

    reader.onerror = () => {
      setImportError('无法读取文件。');
    };

    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = parseIbtracsGeoJson(text);

        const track: TrackTuple[] = parsed.points.map((p) => [
          new Date(Number.isFinite(p.time) ? p.time : Date.now()).toISOString().slice(0, 19).replace('T', ' '),
          p.lat,
          p.lng,
          Number.isFinite(p.windKt) ? p.windKt : null,
          Number.isFinite(p.pressureHpa) ? p.pressureHpa : null,
          p.r34,
          p.r50,
          p.r64,
        ]);

        // Derive the summary fields from the imported data rather than trusting
        // whatever the file claims.
        let peakWind = 0;
        let minPressure = Number.POSITIVE_INFINITY;
        let maxSshs = 0;
        let peakPoint: TrackPoint | null = null;
        let hasRadii = false;

        for (const p of parsed.points) {
          if (Number.isFinite(p.windKt) && p.windKt > peakWind) {
            peakWind = p.windKt;
            peakPoint = p;
          }
          if (Number.isFinite(p.pressureHpa) && p.pressureHpa > 800 && p.pressureHpa < minPressure) {
            minPressure = p.pressureHpa;
          }
          if (p.r34 || p.r50 || p.r64) hasRadii = true;
        }

        const windFromKt = (w: number): number => {
          if (w >= 137) return 5;
          if (w >= 113) return 4;
          if (w >= 96) return 3;
          if (w >= 83) return 2;
          if (w >= 64) return 1;
          return 0;
        };
        maxSshs = windFromKt(peakWind);

        const id = `import-${Date.now().toString(36)}`;

        const record: CycloneRecord = {
          id,
          name: parsed.name,
          nameZh: parsed.name,
          nameEn: parsed.name,
          basin: parsed.basin,
          year: parsed.year ?? new Date().getUTCFullYear(),
          note: `外部导入 · ${parsed.points.length} 个轨迹点`,
          peakWindKt: peakWind,
          minPressureHpa: Number.isFinite(minPressure) ? minPressure : 0,
          maxSshs,
          ace: 0,
          hasWindRadii: hasRadii,
          peakPoint: {
            iso: peakPoint && Number.isFinite(peakPoint.time)
              ? new Date(peakPoint.time).toISOString().slice(0, 19).replace('T', ' ')
              : '',
            lat: peakPoint?.lat ?? 0,
            lon: peakPoint?.lng ?? 0,
            windKt: peakPoint?.windKt ?? null,
            presHpa: peakPoint?.pressureHpa ?? null,
            r34: peakPoint?.r34 ?? null,
            r50: peakPoint?.r50 ?? null,
            r64: peakPoint?.r64 ?? null,
          },
          track,
        };

        setImported((prev) => [...prev, record]);
        setImportWarnings(parsed.warnings);
        setSelectedId(id);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : '导入失败');
      }
    };

    reader.readAsText(file);
  }, []);

  /* ---------------- climate ---------------- */

  const [climatePoint, setClimatePoint] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedDate, setSelectedDate] = useState('1998-08-01');
  const [daily, setDaily] = useState<DailyRecord | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);

  const [series, setSeries] = useState<ClimateSeries | null>(null);
  const [stripes, setStripes] = useState<StripeData | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  const dailyAbort = useRef<AbortController | null>(null);
  const seriesAbort = useRef<AbortController | null>(null);
  const dailyRun = useRef(0);
  const seriesRun = useRef(0);

  // Default the analysis point to the probe location when the panel opens.
  useEffect(() => {
    if (panels.climate && !climatePoint && probe) setClimatePoint(probe);
  }, [panels.climate, climatePoint, probe]);

  const loadDaily = useCallback(
    (point: { lat: number; lng: number }, date: string) => {
      const run = dailyRun.current + 1;
      dailyRun.current = run;

      dailyAbort.current?.abort();
      const controller = new AbortController();
      dailyAbort.current = controller;

      setDailyLoading(true);
      setDailyError(null);

      fetchDailyRecord({ lat: point.lat, lng: point.lng, date, signal: controller.signal })
        .then((rec) => {
          if (run !== dailyRun.current) return;
          setDaily(rec);
          setDailyLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== dailyRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setDailyError(err instanceof Error ? err.message : 'ERA5 查询失败');
          setDailyLoading(false);
        });
    },
    [],
  );

  const loadSeries = useCallback((point: { lat: number; lng: number }) => {
    const run = seriesRun.current + 1;
    seriesRun.current = run;

    seriesAbort.current?.abort();
    const controller = new AbortController();
    seriesAbort.current = controller;

    setSeriesLoading(true);
    setSeriesError(null);

    fetchClimateSeries({
      lat: point.lat,
      lng: point.lng,
      startYear: CLIMATE_START_YEAR,
      endYear: CLIMATE_END_YEAR,
      baselineWindow: [1961, 1990],
      signal: controller.signal,
    })
      .then((s) => {
        if (run !== seriesRun.current) return;
        setSeries(s);
        setStripes(computeStripes(s));
        setSeriesLoading(false);
      })
      .catch((err: unknown) => {
        if (run !== seriesRun.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setSeriesError(err instanceof Error ? err.message : '气候序列获取失败');
        setSeriesLoading(false);
      });
  }, []);

  const retryDaily = useCallback(() => {
    if (climatePoint) loadDaily(climatePoint, selectedDate);
  }, [climatePoint, selectedDate, loadDaily]);

  const retrySeries = useCallback(() => {
    if (climatePoint) loadSeries(climatePoint);
  }, [climatePoint, loadSeries]);

  // Fetch both products whenever the analysis point changes.
  useEffect(() => {
    if (!panels.climate || !climatePoint) return;
    loadDaily(climatePoint, selectedDate);
    loadSeries(climatePoint);
    // Deliberately not depending on selectedDate: the date has its own query
    // button so dragging the date picker does not fire a request per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels.climate, climatePoint, loadDaily, loadSeries]);

  const setSelectedDateAndFetch = useCallback(
    (d: string) => {
      setSelectedDate(d);
      if (climatePoint) loadDaily(climatePoint, d);
    },
    [climatePoint, loadDaily],
  );

  const jumpToEvent = useCallback(
    (eventId: string) => {
      const event = HISTORICAL_EVENTS.find((e) => e.id === eventId);
      if (!event) return;

      const point = { lat: event.lat, lng: event.lng };
      setClimatePoint(point);
      setSelectedDate(event.date);
      loadDaily(point, event.date);
    },
    [loadDaily],
  );

  /* cleanup */
  useEffect(
    () => () => {
      dailyAbort.current?.abort();
      seriesAbort.current?.abort();
    },
    [],
  );

  const climateSpan = useMemo(
    () => ({ from: CLIMATE_START_YEAR, to: CLIMATE_END_YEAR }),
    [],
  );

  return {
    panels,
    openPanel,
    closePanel,

    records,
    specs,
    selectedId,
    selectCyclone,

    timeIndex,
    setTimeIndex,

    visible,
    toggleVisible,
    showRings,
    toggleRings,

    compareIds,
    toggleCompare,
    comparisonMetric,
    setComparisonMetric,

    arenaPoint,
    setArenaPoint,

    activeTrack,
    activePoint,

    importWarnings,
    importError,
    importFile,

    climatePoint,
    setClimatePoint,

    daily,
    dailyLoading,
    dailyError,
    selectedDate,
    setSelectedDate: setSelectedDateAndFetch,
    retryDaily,
    jumpToEvent,

    series,
    stripes,
    seriesLoading,
    seriesError,
    retrySeries,
    climateSpan,
  };
}
