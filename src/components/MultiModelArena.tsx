/**
 * MultiModelArena — four-supercomputer comparison panel.
 *
 * Three views over the same fetch:
 *   1. Consensus plume: per-model time series with the spread band behind them.
 *   2. Spread strip: standard deviation over time, with chaos windows marked.
 *   3. Disagreement readout: which model is the outlier right now.
 *
 * The panel is deliberately explicit about what "chaos window" means, because a
 * highlight without an explanation is just decoration.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  RotateCw,
  Activity,
  TrendingUp,
  CloudRain,
  Gauge,
  Wind,
  MapPin,
} from 'lucide-react';
import {
  ARENA_MODELS,
  ARENA_VARIABLES,
  type ArenaResult,
  type ArenaVariableId,
  type ArenaModelId,
} from '../data/stage3';

export interface MultiModelArenaProps {
  open: boolean;
  onClose: () => void;
  arena: ArenaResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  variable: ArenaVariableId;
  onVariableChange: (v: ArenaVariableId) => void;
  point: { lat: number; lng: number } | null;
  timeIndex: number;
  onTimeIndexChange: (i: number) => void;
}

const VARIABLE_ICONS: Record<ArenaVariableId, typeof Wind> = {
  temperature_2m: TrendingUp,
  precipitation: CloudRain,
  surface_pressure: Gauge,
  wind_gusts_10m: Wind,
};

export function MultiModelArena({
  open,
  onClose,
  arena,
  loading,
  error,
  onRetry,
  variable,
  onVariableChange,
  point,
  timeIndex,
  onTimeIndexChange,
}: MultiModelArenaProps) {
  const plumeRef = useRef<HTMLCanvasElement | null>(null);
  const spreadRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  /* ---------------- draw: consensus plume ---------------- */
  useEffect(() => {
    if (!open || !arena || arena.spread.length === 0) return;
    const canvas = plumeRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawPlume(ctx, canvas, arena, hoverIndex);
  }, [open, arena, hoverIndex]);

  /* ---------------- draw: spread strip ---------------- */
  useEffect(() => {
    if (!open || !arena || arena.spread.length === 0) return;
    const canvas = spreadRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawSpread(ctx, canvas, arena, hoverIndex, timeIndex);
  }, [open, arena, hoverIndex, timeIndex]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = plumeRef.current;
      if (!canvas || !arena) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const { left, right } = plotBounds({ width: rect.width, height: rect.height });
      const n = arena.spread.length;

      if (x < left || x > right || n === 0) {
        setHoverIndex(null);
        return;
      }

      const t = (x - left) / (right - left);
      setHoverIndex(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
    },
    [arena],
  );

  /* ---------------- derived readouts ---------------- */
  const current = arena?.spread[Math.min(hoverIndex ?? timeIndex, (arena?.spread.length ?? 1) - 1)];

  const outlier = useMemo(() => {
    if (!current) return null;
    const entries = ARENA_MODELS.map((m) => ({
      model: m,
      value: current.values[m.id as ArenaModelId],
    })).filter((e) => Number.isFinite(e.value));

    if (entries.length < 2) return null;

    const mean = current.mean;
    const sorted = [...entries].sort((a, b) => Math.abs(b.value - mean) - Math.abs(a.value - mean));
    return sorted[0];
  }, [current]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[92vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl">
        {/* header */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-400/15">
            <Activity size={13} className="text-cyan-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              多超算模型同屏竞技场
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {point
                ? `${point.lat.toFixed(2)}°, ${point.lng.toFixed(2)}° · ${arena?.spread.length ?? 0} 时次`
                : '等待选点'}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9.5px] text-cyan-300 transition-colors hover:bg-cyan-500/10 disabled:opacity-40"
            >
              <RotateCw size={10} className={loading ? 'animate-aether-spin' : ''} />
              重取
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-rose-300"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        {/* variable tabs */}
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-cyan-500/10 px-3 py-1.5">
          {ARENA_VARIABLES.map((v) => {
            const Icon = VARIABLE_ICONS[v.id];
            const active = variable === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onVariableChange(v.id)}
                className={[
                  'flex items-center gap-1 rounded-md px-2 py-1 text-[9.5px] transition-colors',
                  active
                    ? 'bg-cyan-400/18 text-cyan-200'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                ].join(' ')}
              >
                <Icon size={10} />
                {v.label}
              </button>
            );
          })}

          <div className="ml-auto flex flex-wrap items-center gap-2 px-1">
            {ARENA_MODELS.map((m) => (
              <span key={m.id} className="flex items-center gap-1 text-[8.5px] text-slate-400">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: m.color }}
                />
                {m.label}
              </span>
            ))}
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="flex h-[320px] flex-col items-center justify-center gap-3">
              <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
              <p className="text-[11px] text-slate-400">正在拉取四模型 10 天预报…</p>
            </div>
          ) : error ? (
            <div className="flex h-[320px] flex-col items-center justify-center gap-3 px-8 text-center">
              <AlertTriangle size={20} className="text-amber-400" />
              <p className="text-[11px] text-amber-200">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md bg-amber-500/15 px-3 py-1 text-[10px] text-amber-200 hover:bg-amber-500/25"
              >
                重试
              </button>
            </div>
          ) : arena ? (
            <div className="space-y-2">
              {/* plume */}
              <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <p className="hud-label">
                    模型分歧折线 · {ARENA_VARIABLES.find((v) => v.id === variable)?.label}
                  </p>
                  <span className="hud-value text-[8.5px] text-cyan-400/80">{arena.unit}</span>
                </div>
                <canvas
                  ref={plumeRef}
                  onMouseMove={handleMove}
                  onMouseLeave={() => setHoverIndex(null)}
                  className="w-full cursor-crosshair rounded"
                />
              </section>

              {/* spread */}
              <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <p className="hud-label">集合离散度（标准差）</p>
                  <span className="text-[8.5px] text-amber-300/80">
                    高不确定性混沌窗口 {arena.chaosWindows.length} 段
                  </span>
                </div>
                <canvas ref={spreadRef} className="w-full rounded" />
              </section>

              {/* readout */}
              <div className="grid gap-2 sm:grid-cols-2">
                <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
                  <p className="hud-label mb-1.5">
                    {hoverIndex !== null ? '悬停时次' : '当前时次'} · 四模型读数
                  </p>
                  <div className="space-y-1">
                    {ARENA_MODELS.map((m) => {
                      const v = current?.values[m.id as ArenaModelId];
                      const mean = current?.mean;
                      const delta =
                        Number.isFinite(v) && Number.isFinite(mean)
                          ? (v as number) - (mean as number)
                          : Number.NaN;

                      return (
                        <div key={m.id} className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: m.color }}
                          />
                          <span className="w-[74px] shrink-0 truncate text-[9px] text-slate-400">
                            {m.label}
                          </span>
                          <span className="hud-value text-[10px] text-slate-200">
                            {Number.isFinite(v) ? (v as number).toFixed(1) : '—'}
                          </span>
                          <span
                            className="hud-value ml-auto text-[8.5px]"
                            style={{
                              color:
                                Number.isFinite(delta) && Math.abs(delta) > 0.5
                                  ? delta > 0
                                    ? '#fb923c'
                                    : '#22d3ee'
                                  : '#475569',
                            }}
                          >
                            {Number.isFinite(delta)
                              ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`
                              : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-1.5 grid grid-cols-2 gap-1 border-t border-white/5 pt-1.5">
                    <Kv label="模型均值" value={fmt(current?.mean, 1)} />
                    <Kv
                      label="离散度 σ"
                      value={fmt(current?.spread, 2)}
                      color={
                        Number.isFinite(current?.spread) &&
                        (current?.spread ?? 0) > arena.maxSpread * 0.6
                          ? '#f97316'
                          : '#94a3b8'
                      }
                    />
                  </div>
                </section>

                <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
                  <p className="hud-label mb-1.5">分歧诊断</p>

                  {outlier ? (
                    <div className="mb-2 flex items-center gap-1.5 rounded bg-white/[0.03] px-1.5 py-1">
                      <MapPin size={9} className="shrink-0 text-amber-400" />
                      <span className="text-[9px] text-slate-400">最大偏离</span>
                      <span
                        className="hud-value ml-auto text-[9.5px]"
                        style={{ color: outlier.model.color }}
                      >
                        {outlier.model.label}
                      </span>
                      <span className="hud-value text-[9px] text-slate-500">
                        {fmt(outlier.value, 1)}
                      </span>
                    </div>
                  ) : null}

                  <p className="text-[8.5px] leading-relaxed text-slate-500">
                    离散度是该时次四个模型的标准差。超过峰值 60% 的连续时段被标为
                    <span className="text-amber-300"> 混沌窗口</span>
                    ——此时模型对天气系统的位置/强度尚未收敛，预报可信度低。
                  </p>

                  {arena.chaosWindows.length > 0 ? (
                    <div className="mt-1.5 space-y-0.5">
                      {arena.chaosWindows.slice(0, 3).map((w, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded bg-amber-500/[0.07] px-1.5 py-0.5 text-[8.5px]"
                        >
                          <span className="text-slate-400">
                            {formatShort(arena.times[w.startIndex])} → {formatShort(arena.times[w.endIndex])}
                          </span>
                          <span className="hud-value text-amber-300">
                            σ {w.peakSpread.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[8.5px] text-emerald-400/70">四模型高度一致</p>
                  )}
                </section>
              </div>
            </div>
          ) : (
            <div className="flex h-[320px] flex-col items-center justify-center gap-2">
              <p className="text-[11px] text-slate-500">在地球上点击任意位置开始对比</p>
            </div>
          )}
        </div>

        {/* footer scrub */}
        {arena && arena.spread.length > 0 ? (
          <footer className="flex shrink-0 items-center gap-2 border-t border-cyan-500/10 px-3 py-1.5">
            <span className="hud-value shrink-0 text-[8.5px] text-slate-500">
              {formatShort(arena.times[0])}
            </span>
            <input
              type="range"
              min={0}
              max={arena.spread.length - 1}
              value={Math.min(timeIndex, arena.spread.length - 1)}
              onChange={(e) => onTimeIndexChange(Number(e.target.value))}
              className="min-w-0 flex-1"
              aria-label="时序位置"
            />
            <span className="hud-value shrink-0 text-[8.5px] text-slate-500">
              {formatShort(arena.times[arena.times.length - 1])}
            </span>
            <span className="hud-value shrink-0 text-[9px] text-cyan-300">
              {current ? formatShort(current.time) : '—'}
            </span>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Canvas drawing                                                     */
/* ------------------------------------------------------------------ */

const PAD = { top: 12, right: 12, bottom: 22, left: 42 };

function plotBounds(surface: { width: number; height: number }) {
  return {
    left: PAD.left,
    right: surface.width - PAD.right,
    top: PAD.top,
    bottom: surface.height - PAD.bottom,
  };
}

/**
 * Size a canvas for HiDPI and return a context in CSS-pixel coordinates.
 *
 * Every drawing routine works in CSS pixels and lets the transform absorb the
 * device pixel ratio, so the same layout maths is used for hit-testing and
 * painting.
 */
interface CanvasSurface {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

function prepareCanvas(canvas: HTMLCanvasElement, cssHeight = 200): CanvasSurface | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  if (width <= 0) return null;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, cssHeight);

  return { ctx, width, height: cssHeight };
}

function drawPlume(
  _ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  arena: ArenaResult,
  hoverIndex: number | null,
): void {
  const surface = prepareCanvas(canvas);
  if (!surface) return;

  const c = surface.ctx;
  const { left, right, top, bottom } = plotBounds(surface);

  const n = arena.spread.length;

  // Value extent across every model and timestep.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of arena.series) {
    for (const v of s.values) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-6) {
    lo = 0;
    hi = 1;
  }

  // Pad so curves do not touch the frame.
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;

  const xAt = (i: number) => left + (i / Math.max(1, n - 1)) * (right - left);
  const yAt = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);

  // Grid + value axis.
  c.strokeStyle = 'rgba(148,163,184,0.12)';
  c.lineWidth = 1;
  c.font = '8px ui-monospace, monospace';
  c.fillStyle = 'rgba(148,163,184,0.75)';
  c.textAlign = 'right';
  c.textBaseline = 'middle';

  for (let k = 0; k <= 4; k += 1) {
    const v = lo + ((hi - lo) * k) / 4;
    const y = yAt(v);
    c.beginPath();
    c.moveTo(left, y);
    c.lineTo(right, y);
    c.stroke();
    c.fillText(v.toFixed(1), left - 4, y);
  }

  // Chaos window bands, drawn behind everything.
  for (const win of arena.chaosWindows) {
    const x0 = xAt(win.startIndex);
    const x1 = xAt(win.endIndex);
    c.fillStyle = 'rgba(251,146,60,0.10)';
    c.fillRect(x0, top, x1 - x0, bottom - top);
    c.strokeStyle = 'rgba(251,146,60,0.28)';
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(x0, top);
    c.lineTo(x0, bottom);
    c.moveTo(x1, top);
    c.lineTo(x1, bottom);
    c.stroke();
    c.setLineDash([]);
  }

  // Spread band: mean +/- sigma.
  c.beginPath();
  let started = false;
  for (let i = 0; i < n; i += 1) {
    const p = arena.spread[i];
    if (!Number.isFinite(p.mean) || !Number.isFinite(p.spread)) continue;
    const x = xAt(i);
    const y = yAt(p.mean + p.spread);
    if (!started) {
      c.moveTo(x, y);
      started = true;
    } else c.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = arena.spread[i];
    if (!Number.isFinite(p.mean) || !Number.isFinite(p.spread)) continue;
    c.lineTo(xAt(i), yAt(p.mean - p.spread));
  }
  if (started) {
    c.closePath();
    c.fillStyle = 'rgba(148,163,184,0.10)';
    c.fill();
  }

  // Mean line.
  c.strokeStyle = 'rgba(226,232,240,0.45)';
  c.lineWidth = 1.2;
  c.setLineDash([4, 3]);
  c.beginPath();
  started = false;
  for (let i = 0; i < n; i += 1) {
    const p = arena.spread[i];
    if (!Number.isFinite(p.mean)) continue;
    const x = xAt(i);
    const y = yAt(p.mean);
    if (!started) {
      c.moveTo(x, y);
      started = true;
    } else c.lineTo(x, y);
  }
  c.stroke();
  c.setLineDash([]);

  // One line per model.
  for (const s of arena.series) {
    const meta = ARENA_MODELS.find((m) => m.id === s.model);
    c.strokeStyle = meta?.color ?? '#94a3b8';
    c.lineWidth = 1.5;
    c.beginPath();
    started = false;
    for (let i = 0; i < n; i += 1) {
      const v = s.values[i];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        c.moveTo(x, y);
        started = true;
      } else c.lineTo(x, y);
    }
    c.stroke();
  }

  // Hover crosshair + dots.
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < n) {
    const x = xAt(hoverIndex);
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(x, top);
    c.lineTo(x, bottom);
    c.stroke();
    c.setLineDash([]);

    for (const s of arena.series) {
      const v = s.values[hoverIndex];
      if (!Number.isFinite(v)) continue;
      const meta = ARENA_MODELS.find((m) => m.id === s.model);
      c.beginPath();
      c.arc(x, yAt(v), 3, 0, Math.PI * 2);
      c.fillStyle = meta?.color ?? '#94a3b8';
      c.fill();
      c.strokeStyle = '#0b1220';
      c.lineWidth = 1;
      c.stroke();
    }
  }
}

function drawSpread(
  _ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  arena: ArenaResult,
  hoverIndex: number | null,
  timeIndex: number,
): void {
  const surface = prepareCanvas(canvas, 120);
  if (!surface) return;

  const c = surface.ctx;
  const { left, right, top, bottom } = plotBounds(surface);

  const n = arena.spread.length;
  const maxSpread = Math.max(arena.maxSpread, 1e-6);

  const xAt = (i: number) => left + (i / Math.max(1, n - 1)) * (right - left);
  const yAt = (v: number) => bottom - (v / maxSpread) * (bottom - top) * 0.92;

  // Baseline.
  c.strokeStyle = 'rgba(148,163,184,0.16)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(left, bottom);
  c.lineTo(right, bottom);
  c.stroke();

  // Threshold line at 60% of peak (the chaos definition).
  const threshold = maxSpread * 0.6;
  const ty = yAt(threshold);
  c.strokeStyle = 'rgba(251,146,60,0.5)';
  c.setLineDash([4, 3]);
  c.beginPath();
  c.moveTo(left, ty);
  c.lineTo(right, ty);
  c.stroke();
  c.setLineDash([]);

  c.font = '7.5px ui-monospace, monospace';
  c.fillStyle = 'rgba(251,146,60,0.85)';
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  c.fillText(`混沌阈值 σ=${threshold.toFixed(2)}`, left + 3, ty - 2);

  // Filled area.
  c.beginPath();
  c.moveTo(xAt(0), bottom);
  for (let i = 0; i < n; i += 1) {
    const s = arena.spread[i].spread;
    const v = Number.isFinite(s) ? s : 0;
    c.lineTo(xAt(i), yAt(v));
  }
  c.lineTo(xAt(n - 1), bottom);
  c.closePath();

  const grad = c.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, 'rgba(251,146,60,0.45)');
  grad.addColorStop(1, 'rgba(251,146,60,0.04)');
  c.fillStyle = grad;
  c.fill();

  // Outline.
  c.strokeStyle = 'rgba(251,146,60,0.85)';
  c.lineWidth = 1.2;
  c.beginPath();
  let started = false;
  for (let i = 0; i < n; i += 1) {
    const s = arena.spread[i].spread;
    if (!Number.isFinite(s)) {
      started = false;
      continue;
    }
    const x = xAt(i);
    const y = yAt(s);
    if (!started) {
      c.moveTo(x, y);
      started = true;
    } else c.lineTo(x, y);
  }
  c.stroke();

  // Cursor.
  const cursor = hoverIndex ?? timeIndex;
  if (cursor >= 0 && cursor < n) {
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(xAt(cursor), top);
    c.lineTo(xAt(cursor), bottom);
    c.stroke();
    c.setLineDash([]);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function Kv({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[8px] text-slate-500">{label}</span>
      <span className="hud-value text-[10px]" style={{ color: color ?? '#e2e8f0' }}>
        {value}
      </span>
    </div>
  );
}

function fmt(v: number | undefined, digits: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function formatShort(epochMs: number | undefined): string {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}Z`;
}
