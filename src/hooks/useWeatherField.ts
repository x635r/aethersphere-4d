/**
 * useWeatherField — owns the fetch -> worker -> field-set pipeline.
 *
 * Responsibilities kept here rather than in a component:
 *  - debounce rapid level/scalar changes so scrubbing the dock does not spend
 *    the Open-Meteo minute budget,
 *  - cancel in-flight requests with AbortController,
 *  - translate every failure into a message the HUD can show, without
 *    throwing into the React tree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchField, UpstreamQuotaError } from '../data/openMeteo';
import { buildField } from '../data/gridWorkerClient';
import { synthesisePayload } from '../data/synthetic';
import type { GridSpec, WeatherFieldSet } from '../core/types';
import type { ScalarFieldId } from '../core/levels';

/** Globe sampling lattice. 24x12 = 288 points = 288 billed calls per load. */
export const DEFAULT_GRID: GridSpec = { cols: 24, rows: 12 };

/** Timeline window: 2 days back, 5 days ahead at hourly resolution. */
export const WINDOW_PAST_DAYS = 2;
export const WINDOW_FUTURE_DAYS = 5;

export interface UseWeatherFieldArgs {
  level: number | 'surface';
  scalarId: ScalarFieldId;
  enabled?: boolean;
  grid?: GridSpec;
}

export interface UseWeatherFieldResult {
  fieldSet: WeatherFieldSet | null;
  loading: boolean;
  error: string | null;
  progressLabel: string;
  reload: () => void;
  meta: { billed: number; cacheHit: boolean; model: string };
  /** True when the data is the offline synthetic pattern, not upstream data. */
  synthetic: boolean;
}

function windowDates(now = Date.now()): { startMs: number; endMs: number } {
  const dayMs = 86_400_000;
  // Align to a whole UTC day so the response covers full hourly blocks.
  const startOfToday = Math.floor(now / dayMs) * dayMs;
  return {
    startMs: startOfToday - WINDOW_PAST_DAYS * dayMs,
    endMs: startOfToday + WINDOW_FUTURE_DAYS * dayMs,
  };
}

export function useWeatherField({
  level,
  scalarId,
  enabled = true,
  grid = DEFAULT_GRID,
}: UseWeatherFieldArgs): UseWeatherFieldResult {
  const [fieldSet, setFieldSet] = useState<WeatherFieldSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState('');
  const [meta, setMeta] = useState({ billed: 0, cacheHit: false, model: '' });
  const [synthetic, setSynthetic] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    // Drop cached signatures for this combination by forcing a new run id;
    // the network layer's own cache still short-circuits identical windows.
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;

    const { startMs, endMs } = windowDates();

    setLoading(true);
    setError(null);
    setProgressLabel('正在请求 Open-Meteo 全球格点…');

    /**
     * Fall back to the offline synthetic field. Used when upstream refuses the
     * request (quota, outage, CORS) so the engine stays inspectable; the HUD
     * labels the data as synthetic so it cannot be mistaken for a forecast.
     */
    const buildSynthetic = async (reason: string) => {
      const hours = Math.min(72, Math.ceil((endMs - startMs) / 3_600_000));
      const { payload, times } = synthesisePayload({ grid, level, hours, startMs });

      setProgressLabel('上游不可用，正在生成离线演示场…');

      const built = await buildField({
        grid,
        level,
        scalarId,
        times,
        payload,
        model: 'offline-synthetic',
      });

      if (cancelled || runId !== runIdRef.current) return;

      setFieldSet(built as WeatherFieldSet);
      setMeta({ billed: 0, cacheHit: false, model: '离线演示场' });
      setSynthetic(true);
      setError(reason);
      setProgressLabel('');
      setLoading(false);
    };

    const timer = window.setTimeout(async () => {
      try {
        const result = await fetchField({
          grid,
          level,
          scalarId,
          startMs,
          endMs,
          signal: controller.signal,
        });

        if (cancelled || runId !== runIdRef.current) return;

        setProgressLabel(
          result.cacheHit
            ? '命中本地缓存，正在构建速度场…'
            : `已获取 ${result.billed} 个格点，正在构建速度场…`,
        );

        const built = await buildField({
          grid,
          level,
          scalarId,
          times: result.times,
          payload: result.payload,
          model: result.model,
        });

        if (cancelled || runId !== runIdRef.current) return;

        setFieldSet(built as WeatherFieldSet);
        setMeta({
          billed: result.billed,
          cacheHit: result.cacheHit,
          model: result.model,
        });
        setSynthetic(false);
        setProgressLabel('');
        setLoading(false);
      } catch (err) {
        if (cancelled || runId !== runIdRef.current) return;
        // AbortError is an expected outcome of superseding, not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof Error && err.name === 'AbortError') return;

        if (err instanceof UpstreamQuotaError) {
          await buildSynthetic(err.message);
          return;
        }

        const message =
          err instanceof Error ? err.message : '未知错误';

        // Network-level failures also degrade to the offline field.
        try {
          await buildSynthetic(`上游请求失败：${message}`);
        } catch {
          setError(message);
          setProgressLabel('');
          setLoading(false);
        }
      }
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [level, scalarId, enabled, grid, nonce]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { fieldSet, loading, error, progressLabel, reload, meta, synthetic };
}
