/**
 * Application store.
 *
 * Kept intentionally flat: the map component and the HUD both subscribe, and
 * shallow selectors keep re-renders scoped to what actually changed.
 */

import { create } from 'zustand';
import type { ScalarFieldId } from '../core/levels';
import { ELEVATOR_LEVELS } from '../core/levels';
import type { WeatherFieldSet } from '../core/types';

export type ProjectionType = 'globe' | 'mercator';
export type SpeedUnit = 'ms' | 'kmh' | 'kt';
export type TimeMode = 'utc' | 'local';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProbeReadout {
  lng: number;
  lat: number;
  windSpeedMs: number;
  windDirection: number;
  scalarValue: number;
  scalarId: ScalarFieldId;
  level: number | 'surface';
  /** Present when the sampled location is on the globe. */
  altitudeM: number | null;
  utcMs: number;
}

export interface AppState {
  /* ---- view ---- */
  projection: ProjectionType;
  setProjection: (projection: ProjectionType) => void;

  /* ---- data selection ---- */
  level: number | 'surface';
  setLevel: (level: number | 'surface') => void;

  scalarId: ScalarFieldId;
  setScalarId: (id: ScalarFieldId) => void;

  activeGroup: string;
  setActiveGroup: (group: string) => void;

  /* ---- layers ---- */
  heatVisible: boolean;
  streakVisible: boolean;
  terminatorVisible: boolean;
  particleCount: number;
  heatOpacity: number;
  streakOpacity: number;

  toggleHeat: () => void;
  toggleStreaks: () => void;
  toggleTerminator: () => void;
  setParticleCount: (count: number) => void;
  setHeatOpacity: (value: number) => void;
  setStreakOpacity: (value: number) => void;

  /* ---- timeline ---- */
  times: number[];
  timeIndex: number;
  playing: boolean;
  speed: number;
  timeMode: TimeMode;

  setTimes: (times: number[]) => void;
  setTimeIndex: (index: number) => void;
  togglePlaying: () => void;
  setSpeed: (speed: number) => void;
  setTimeMode: (mode: TimeMode) => void;

  /* ---- data ---- */
  status: LoadStatus;
  error: string | null;
  fieldSet: WeatherFieldSet | null;
  modelLabel: string;
  billedCalls: number;
  cacheHit: boolean;
  synthetic: boolean;
  lastLoadedAt: number | null;

  setStatus: (status: LoadStatus) => void;
  setError: (error: string | null) => void;
  setSynthetic: (synthetic: boolean) => void;
  setFieldSet: (fieldSet: WeatherFieldSet, meta: { billed: number; cacheHit: boolean; model: string }) => void;

  /* ---- probe ---- */
  speedUnit: SpeedUnit;
  setSpeedUnit: (unit: SpeedUnit) => void;
  probe: ProbeReadout | null;
  setProbe: (probe: ProbeReadout | null) => void;

  /* ---- ui ---- */
  hudVisible: boolean;
  toggleHud: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  projection: 'globe',
  setProjection: (projection) => set({ projection }),

  level: 500,
  setLevel: (level) => set({ level }),

  scalarId: 'wind_speed',
  setScalarId: (scalarId) => set({ scalarId }),

  activeGroup: 'L3',
  setActiveGroup: (activeGroup) => set({ activeGroup }),

  heatVisible: true,
  streakVisible: true,
  terminatorVisible: true,
  particleCount: 24_000,
  heatOpacity: 0.52,
  streakOpacity: 0.8,

  toggleHeat: () => set((s) => ({ heatVisible: !s.heatVisible })),
  toggleStreaks: () => set((s) => ({ streakVisible: !s.streakVisible })),
  toggleTerminator: () => set((s) => ({ terminatorVisible: !s.terminatorVisible })),
  setParticleCount: (particleCount) => set({ particleCount }),
  setHeatOpacity: (heatOpacity) => set({ heatOpacity }),
  setStreakOpacity: (streakOpacity) => set({ streakOpacity }),

  times: [],
  timeIndex: 0,
  playing: false,
  speed: 1,
  timeMode: 'utc',

  setTimes: (times) =>
    set((state) => {
      // Keep the cursor on the same instant when a new window arrives.
      const current = state.times[state.timeIndex];
      let nextIndex = 0;
      if (current !== undefined) {
        const found = times.findIndex((t) => t >= current);
        nextIndex = found === -1 ? times.length - 1 : found;
      }
      return { times, timeIndex: Math.max(0, nextIndex) };
    }),

  setTimeIndex: (timeIndex) => set({ timeIndex }),
  togglePlaying: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  setTimeMode: (timeMode) => set({ timeMode }),

  status: 'idle',
  error: null,
  fieldSet: null,
  modelLabel: 'Open-Meteo 无缝多模型',
  billedCalls: 0,
  cacheHit: false,
  synthetic: false,
  lastLoadedAt: null,

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setSynthetic: (synthetic) => set({ synthetic }),
  setFieldSet: (fieldSet, meta) =>
    set({
      fieldSet,
      status: 'ready',
      error: null,
      billedCalls: meta.billed,
      cacheHit: meta.cacheHit,
      modelLabel: meta.model,
      lastLoadedAt: Date.now(),
    }),

  speedUnit: 'ms',
  setSpeedUnit: (speedUnit) => set({ speedUnit }),
  probe: null,
  setProbe: (probe) => set({ probe }),

  hudVisible: true,
  toggleHud: () => set((s) => ({ hudVisible: !s.hudVisible })),
}));

/** Speed conversion helpers shared by the probe and the legend. */
export function convertSpeed(ms: number, unit: SpeedUnit): number {
  switch (unit) {
    case 'kmh':
      return ms * 3.6;
    case 'kt':
      return ms * 1.9438444924406046;
    default:
      return ms;
  }
}

export function speedUnitLabel(unit: SpeedUnit): string {
  switch (unit) {
    case 'kmh':
      return 'km/h';
    case 'kt':
      return 'kt';
    default:
      return 'm/s';
  }
}

/** Index into ELEVATOR_LEVELS for the current level, or -1 if not listed. */
export function elevatorIndexForLevel(level: number | 'surface'): number {
  return ELEVATOR_LEVELS.findIndex((entry) => entry.level === level);
}
