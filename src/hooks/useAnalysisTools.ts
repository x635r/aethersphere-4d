/**
 * useAnalysisTools — orchestrates the two Stage 2 instruments.
 *
 * Owns:
 *  - the active tool mode (probe / sounding / section),
 *  - the polyline being drawn for a cross-section,
 *  - fetching and error state for both the sounding and the transect,
 *  - the highlighted point reported back to the map.
 *
 * Keeping this out of the components means the map canvas and the two panels
 * share one source of truth for "what is the user doing right now".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSounding,
  fetchCrossSection,
  type SoundingProfile,
  type CrossSectionData,
  type LngLatPoint,
} from '../data/sounding';

export type ToolMode = 'probe' | 'sounding' | 'section';

export interface UseAnalysisToolsArgs {
  mode: ToolMode;
  timeMs: number;
}

export interface UseAnalysisToolsResult {
  /* sounding */
  soundingOpen: boolean;
  sounding: SoundingProfile | null;
  soundingLoading: boolean;
  soundingError: string | null;
  soundingPoint: LngLatPoint | null;

  /* section */
  sectionOpen: boolean;
  section: CrossSectionData | null;
  sectionLoading: boolean;
  sectionError: string | null;
  draftNodes: LngLatPoint[];
  sectionHighlight: LngLatPoint | null;

  /* actions */
  requestSounding: (point: LngLatPoint) => void;
  closeSounding: () => void;
  retrySounding: () => void;

  addSectionNode: (point: LngLatPoint) => void;
  finishSection: () => void;
  cancelSection: () => void;
  closeSection: () => void;
  retrySection: () => void;
  setSectionHighlight: (point: LngLatPoint | null) => void;

  /** Reset all tool state (used when switching modes). */
  reset: () => void;
}

export function useAnalysisTools({ mode, timeMs }: UseAnalysisToolsArgs): UseAnalysisToolsResult {
  const [soundingOpen, setSoundingOpen] = useState(false);
  const [sounding, setSounding] = useState<SoundingProfile | null>(null);
  const [soundingLoading, setSoundingLoading] = useState(false);
  const [soundingError, setSoundingError] = useState<string | null>(null);
  const [soundingPoint, setSoundingPoint] = useState<LngLatPoint | null>(null);

  const [sectionOpen, setSectionOpen] = useState(false);
  const [section, setSection] = useState<CrossSectionData | null>(null);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [draftNodes, setDraftNodes] = useState<LngLatPoint[]>([]);
  const [sectionHighlight, setSectionHighlight] = useState<LngLatPoint | null>(null);

  const soundingAbort = useRef<AbortController | null>(null);
  const sectionAbort = useRef<AbortController | null>(null);
  const soundingRun = useRef(0);
  const sectionRun = useRef(0);

  /* ---------------- sounding ---------------- */

  const requestSounding = useCallback(
    (point: LngLatPoint) => {
      const run = soundingRun.current + 1;
      soundingRun.current = run;

      soundingAbort.current?.abort();
      const controller = new AbortController();
      soundingAbort.current = controller;

      setSoundingPoint(point);
      setSoundingOpen(true);
      setSoundingLoading(true);
      setSoundingError(null);

      fetchSounding({ lat: point.lat, lng: point.lng, timeMs, signal: controller.signal })
        .then((profile) => {
          if (run !== soundingRun.current) return;
          setSounding(profile);
          setSoundingLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== soundingRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setSoundingError(err instanceof Error ? err.message : '探空获取失败');
          setSoundingLoading(false);
        });
    },
    [timeMs],
  );

  const closeSounding = useCallback(() => {
    soundingAbort.current?.abort();
    soundingRun.current += 1;
    setSoundingOpen(false);
    setSoundingLoading(false);
  }, []);

  const retrySounding = useCallback(() => {
    if (soundingPoint) requestSounding(soundingPoint);
  }, [soundingPoint, requestSounding]);

  /* ---------------- section ---------------- */

  const addSectionNode = useCallback((point: LngLatPoint) => {
    setDraftNodes((nodes) => {
      // Ignore a duplicate click on (nearly) the same spot.
      const last = nodes[nodes.length - 1];
      if (last && Math.hypot(last.lat - point.lat, last.lng - point.lng) < 0.3) {
        return nodes;
      }
      // Cap at 5 nodes, matching the spec's 2–5 vertex polyline.
      if (nodes.length >= 5) return nodes;
      return [...nodes, point];
    });
  }, []);

  const runSection = useCallback(
    (nodes: LngLatPoint[]) => {
      if (nodes.length < 2) return;

      const run = sectionRun.current + 1;
      sectionRun.current = run;

      sectionAbort.current?.abort();
      const controller = new AbortController();
      sectionAbort.current = controller;

      setSectionOpen(true);
      setSectionLoading(true);
      setSectionError(null);

      fetchCrossSection({ nodes, timeMs, sampleCount: 20, signal: controller.signal })
        .then((data) => {
          if (run !== sectionRun.current) return;
          setSection(data);
          setSectionLoading(false);
        })
        .catch((err: unknown) => {
          if (run !== sectionRun.current) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setSectionError(err instanceof Error ? err.message : '剖面获取失败');
          setSectionLoading(false);
        });
    },
    [timeMs],
  );

  const finishSection = useCallback(() => {
    setDraftNodes((nodes) => {
      if (nodes.length >= 2) runSection(nodes);
      return nodes;
    });
  }, [runSection]);

  const cancelSection = useCallback(() => {
    sectionAbort.current?.abort();
    sectionRun.current += 1;
    setDraftNodes([]);
    setSectionOpen(false);
    setSection(null);
    setSectionLoading(false);
    setSectionError(null);
    setSectionHighlight(null);
  }, []);

  const closeSection = useCallback(() => {
    setSectionOpen(false);
    setSectionHighlight(null);
  }, []);

  const retrySection = useCallback(() => {
    const nodes = section?.nodes ?? draftNodes;
    if (nodes.length >= 2) runSection(nodes);
  }, [section, draftNodes, runSection]);

  const reset = useCallback(() => {
    soundingAbort.current?.abort();
    sectionAbort.current?.abort();
    soundingRun.current += 1;
    sectionRun.current += 1;

    setSoundingOpen(false);
    setSounding(null);
    setSoundingLoading(false);
    setSoundingError(null);
    setSoundingPoint(null);

    setSectionOpen(false);
    setSection(null);
    setSectionLoading(false);
    setSectionError(null);
    setDraftNodes([]);
    setSectionHighlight(null);
  }, []);

  /* Leaving a mode cleans up its transient drawing state. */
  useEffect(() => {
    if (mode !== 'section') setDraftNodes([]);
    if (mode === 'probe') {
      setSoundingOpen(false);
      setSectionOpen(false);
      setSectionHighlight(null);
    }
  }, [mode]);

  /* Abort everything on unmount. */
  useEffect(
    () => () => {
      soundingAbort.current?.abort();
      sectionAbort.current?.abort();
    },
    [],
  );

  /* Re-fetch when the timeline moves while a panel is open. */
  const lastTimeRef = useRef(timeMs);
  useEffect(() => {
    if (lastTimeRef.current === timeMs) return;
    lastTimeRef.current = timeMs;

    if (soundingOpen && soundingPoint) requestSounding(soundingPoint);
    if (sectionOpen && section) runSection(section.nodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMs]);

  return {
    soundingOpen,
    sounding,
    soundingLoading,
    soundingError,
    soundingPoint,

    sectionOpen,
    section,
    sectionLoading,
    sectionError,
    draftNodes,
    sectionHighlight,

    requestSounding,
    closeSounding,
    retrySounding,

    addSectionNode,
    finishSection,
    cancelSection,
    closeSection,
    retrySection,
    setSectionHighlight,

    reset,
  };
}
