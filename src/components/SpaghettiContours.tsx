/**
 * SpaghettiContours — the 500 hPa 5880 gpm ridge comparison view.
 *
 * Renders the four models' subtropical-ridge contours on a standalone Mercator
 * canvas. This is a separate view rather than an overlay on the 3D globe for a
 * concrete reason: four thin contour sets need to be legible and hover-inspectable,
 * and a flat equirect/mercator panel does that far better than a rotating sphere
 * where ridges curl around the limb.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  RotateCw,
  Waves,
  Layers,
} from 'lucide-react';
import type { SpaghettiResult } from '../data/stage3';
import { ARENA_MODELS } from '../data/stage3';
import {
  renderSpaghetti,
  globeMercatorProjection,
  DEFAULT_SPAGHETTI_THEME,
  type SpaghettiRenderStats,
} from '../render/spaghetti';

export interface SpaghettiContoursProps {
  open: boolean;
  onClose: () => void;
  result: SpaghettiResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  timeMs: number;
  contourLevel: number;
}

const CANVAS_HEIGHT = 380;

export function SpaghettiContours({
  open,
  onClose,
  result,
  loading,
  error,
  onRetry,
  timeMs,
  contourLevel,
}: SpaghettiContoursProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<SpaghettiRenderStats | null>(null);
  const [showSecondary, setShowSecondary] = useState(false);
  const [hover, setHover] = useState<{ lng: number; lat: number; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(820);

  /* ---------------- responsive ---------------- */
  useEffect(() => {
    if (!open) return;
    const compute = () => setWidth(Math.max(560, Math.min(window.innerWidth - 120, 980)));
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  /* ---------------- render ---------------- */
  useEffect(() => {
    if (!open || !result) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(CANVAS_HEIGHT * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, CANVAS_HEIGHT);

    const rect = { x: 34, y: 18, width: width - 48, height: CANVAS_HEIGHT - 42 };

    // Background + graticule so the contours have geographic context.
    ctx.fillStyle = '#030712';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let lat = -60; lat <= 60; lat += 30) {
      const y = rect.y + ((90 - lat) / 180) * rect.height;
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.width, y);
      ctx.stroke();
      ctx.fillText(`${lat > 0 ? '+' : ''}${lat}°`, rect.x - 26, y);
    }

    for (let lng = -180; lng <= 180; lng += 60) {
      const x = rect.x + ((lng + 180) / 360) * rect.width;
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.height);
      ctx.stroke();
    }

    // Highlight the 5-40°N band, which spans the ridge's full seasonal range
    // (subtropical highs sit near 25°N in summer and retreat toward 10°N by
    // autumn). A narrower band would imply the ridge is out of place when it is
    // simply following its normal migration.
    const bandTop = rect.y + ((90 - 40) / 180) * rect.height;
    const bandBottom = rect.y + ((90 - 5) / 180) * rect.height;
    ctx.fillStyle = 'rgba(34,211,238,0.035)';
    ctx.fillRect(rect.x, bandTop, rect.width, bandBottom - bandTop);

    const projection = globeMercatorProjection(rect);

    const renderStats = renderSpaghetti({
      result,
      context: ctx,
      projection,
      theme: DEFAULT_SPAGHETTI_THEME,
      showRidge: true,
      extraLevels: showSecondary ? [5700, 5820, 5940, 6000] : [],
      lineWidth: 1.9,
    });

    setStats(renderStats);
  }, [open, result, width, showSecondary]);

  /* ---------------- hover: report lon/lat under the cursor ---------------- */
  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const plotX = 34;
      const plotY = 18;
      const plotW = width - 48;
      const plotH = CANVAS_HEIGHT - 42;

      if (x < plotX || x > plotX + plotW || y < plotY || y > plotY + plotH) {
        setHover(null);
        return;
      }

      const lng = ((x - plotX) / plotW) * 360 - 180;
      const lat = 90 - ((y - plotY) / plotH) * 180;

      setHover({ lng, lat, x, y });
    },
    [width],
  );

  if (!open) return null;

  const stamp = new Date(timeMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[94vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-fuchsia-400/15">
            <Waves size={13} className="text-fuchsia-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              500 hPa 副高特征线 · 四模型面条图
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {contourLevel} gpm 脊线 · {stamp}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowSecondary((v) => !v)}
            className={[
              'ml-2 flex items-center gap-1 rounded px-2 py-1 text-[9px] transition-colors',
              showSecondary
                ? 'bg-fuchsia-400/18 text-fuchsia-200'
                : 'text-slate-500 hover:text-slate-300',
            ].join(' ')}
          >
            <Layers size={9} />
            {showSecondary ? '隐藏副等压线' : '显示副等压线'}
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9px] text-cyan-300 transition-colors hover:bg-cyan-500/10 disabled:opacity-40"
            >
              <RotateCw size={9} className={loading ? 'animate-aether-spin' : ''} />
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

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="flex h-[380px] flex-col items-center justify-center gap-3">
              <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
              <p className="text-[11px] text-slate-400">正在拉取四模型 500 hPa 高度场…</p>
            </div>
          ) : error ? (
            <div className="flex h-[380px] flex-col items-center justify-center gap-3 px-8 text-center">
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
          ) : result ? (
            <div className="space-y-2">
              <div className="relative">
                <canvas
                  ref={canvasRef}
                  onMouseMove={handleMove}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-crosshair rounded-lg"
                />

                {hover ? (
                  <div
                    className="pointer-events-none absolute rounded bg-slate-950/90 px-1.5 py-0.5 text-[8px] text-cyan-200"
                    style={{ left: hover.x + 10, top: hover.y - 8 }}
                  >
                    {hover.lat.toFixed(1)}°, {hover.lng.toFixed(1)}°
                  </div>
                ) : null}
              </div>

              {/* per-model legend with contour counts */}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {ARENA_MODELS.map((m) => {
                  const count = stats?.ridgeCounts[m.id] ?? 0;
                  return (
                    <div
                      key={m.id}
                      className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-4 shrink-0 rounded-sm"
                          style={{ background: m.color }}
                        />
                        <span className="truncate text-[9px] text-slate-300">{m.label}</span>
                      </div>
                      <p className="hud-value mt-0.5 text-[8px] text-slate-500">
                        {count > 0 ? `${count} 段脊线` : '无 5880 线'}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* interpretation */}
              <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <p className="mb-1 text-[9px] text-slate-400">如何读这张图</p>
                <p className="text-[8.5px] leading-relaxed text-slate-500">
                  5880 gpm 线是副热带高压（副高）的经典特征线。条线的纬度位置本身就有意义：
                  盛夏常见于 20–30°N，入秋后随副高南退可落到 10–20°N，冬季最南。
                  当四条线<strong className="text-slate-300">紧密聚拢</strong>，说明四个超级计算机对副高位置
                  高度一致，台风引导气流与寒潮槽线的预报可信度高；当它们
                  <strong className="text-amber-300">扇形散开</strong>，说明环流形势尚未收敛，
                  这通常是中期预报出现大幅调整的前兆。
                </p>
                {stats ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/5 pt-1.5 text-[8px]">
                    <span className="text-slate-500">
                      脊线经度跨度{' '}
                      <span className="hud-value text-cyan-300">
                        {stats.coverageLon.toFixed(0)}°
                      </span>
                    </span>
                    <span className="text-slate-500">
                      模型间最大分歧{' '}
                      <span
                        className="hud-value"
                        style={{
                          color: stats.maxDisagreementDeg > 25 ? '#f97316' : '#34d399',
                        }}
                      >
                        {stats.maxDisagreementDeg.toFixed(1)}°
                      </span>
                    </span>
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
