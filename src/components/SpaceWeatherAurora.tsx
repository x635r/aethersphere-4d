/**
 * SpaceWeatherAurora — the L6 panel.
 *
 * Aurora oval, Kp index dashboard, and the "viewline" (how far south the aurora
 * can be seen). The viewline is computed from the actual OVATION grid rather than
 * the G-scale approximation, because the grid is what the map is drawing.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  Sparkles,
  MapPin,
} from 'lucide-react';
import type { AuroraGrid, KpSeries } from '../data/stage4';
import { sampleAurora } from '../data/stage4';
import {
  buildAuroraRamp,
  auroraLegend,
  auroraViewlineLatitude,
  auroraViewlineLatitudeSouth,
  renderAurora,
} from '../render/aurora';

export interface SpaceWeatherAuroraProps {
  open: boolean;
  onClose: () => void;

  aurora: AuroraGrid | null;
  auroraLoading: boolean;
  auroraError: string | null;
  auroraVisible: boolean;
  onToggleAurora: () => void;
  onRetryAurora: () => void;
  auroraOpacity: number;
  onAuroraOpacityChange: (v: number) => void;

  kp: KpSeries | null;
  kpLoading: boolean;
  kpError: string | null;
  onRetryKp: () => void;

  /** Point under the probe, for the local visibility readout. */
  probe: { lat: number; lng: number } | null;
}

export function SpaceWeatherAurora(props: SpaceWeatherAuroraProps) {
  const {
    open,
    onClose,
    aurora,
    auroraLoading,
    auroraError,
    auroraVisible,
    onToggleAurora,
    onRetryAurora,
    auroraOpacity,
    onAuroraOpacityChange,
    kp,
    kpLoading,
    kpError,
    onRetryKp,
    probe,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ramp = useMemo(() => (aurora ? buildAuroraRamp(aurora) : null), [aurora]);

  /* ---------------- draw the oval preview ---------------- */
  useEffect(() => {
    if (!open || !aurora || !ramp) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 320;
    const height = 200;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Dark sphere-ish backdrop with the two polar caps emphasised.
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(148,163,184,0.14)';
    ctx.lineWidth = 1;
    ctx.font = '7px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const lat of [80, 60, 40, 0, -40, -60, -80]) {
      const y = ((90 - lat) / 180) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${lat}°`, 3, y);
    }

    renderAurora({
      grid: aurora,
      context: ctx,
      rect: { x: 24, y: 0, width: width - 28, height },
      ramp,
      opacity: 1,
      hemisphere: 'both',
    });

  }, [open, aurora, ramp]);

  /* ---------------- derived ---------------- */
  const viewlineNorth = useMemo(
    () => (aurora ? auroraViewlineLatitude(aurora, 10) : null),
    [aurora],
  );
  const viewlineSouth = useMemo(
    () => (aurora ? auroraViewlineLatitudeSouth(aurora, 10) : null),
    [aurora],
  );

  const localProbability = useMemo(() => {
    if (!aurora || !probe) return null;
    return sampleAurora(aurora, probe.lng, probe.lat);
  }, [aurora, probe]);

  const level = kp?.level;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[69] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/82 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-400/15">
            <Sparkles size={13} className="text-emerald-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              空间天气与极光卵
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {aurora
                ? `OVATION 65,160 格点 · 峰值 ${aurora.peak.toFixed(0)}% · ${new Date(aurora.observedAt).toISOString().slice(0, 16).replace('T', ' ')}Z`
                : '等待极光网格'}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
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
          {auroraLoading ? (
            <div className="flex h-[260px] flex-col items-center justify-center gap-3">
              <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
              <p className="text-[11px] text-slate-400">正在解析 OVATION 极光网格…</p>
            </div>
          ) : auroraError ? (
            <div className="flex h-[260px] flex-col items-center justify-center gap-3 px-8 text-center">
              <AlertTriangle size={20} className="text-amber-400" />
              <p className="text-[11px] text-amber-200">{auroraError}</p>
              <button
                type="button"
                onClick={onRetryAurora}
                className="rounded-md bg-amber-500/15 px-3 py-1 text-[10px] text-amber-200 hover:bg-amber-500/25"
              >
                重试
              </button>
            </div>
          ) : aurora && ramp ? (
            <div className="grid gap-2 lg:grid-cols-[340px_1fr]">
              {/* oval preview */}
              <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <p className="hud-label">全球极光卵</p>
                  <button
                    type="button"
                    onClick={onToggleAurora}
                    className={[
                      'rounded px-1.5 py-0.5 text-[8.5px] transition-colors',
                      auroraVisible ? 'bg-emerald-400/18 text-emerald-200' : 'text-slate-500',
                    ].join(' ')}
                  >
                    {auroraVisible ? '图层已开' : '图层已关'}
                  </button>
                </div>

                <canvas ref={canvasRef} className="rounded" />

                <label className="mt-1.5 block">
                  <span className="flex items-center justify-between">
                    <span className="hud-label">不透明度</span>
                    <span className="hud-value text-[8.5px] text-cyan-300">
                      {Math.round(auroraOpacity * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(auroraOpacity * 100)}
                    onChange={(e) => onAuroraOpacityChange(Number(e.target.value) / 100)}
                    className="mt-0.5 w-full"
                  />
                </label>
              </section>

              {/* Kp + legend */}
              <div className="space-y-2">
                {/* Kp gauge */}
                <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <p className="hud-label">行星地磁 Kp 指数</p>
                    {kpLoading ? (
                      <Loader2 size={10} className="animate-aether-spin text-cyan-400" />
                    ) : kpError ? (
                      <button
                        type="button"
                        onClick={onRetryKp}
                        className="text-[8.5px] text-amber-300 hover:text-amber-200"
                      >
                        重试
                      </button>
                    ) : (
                      <span
                        className="rounded px-1.5 py-px text-[8.5px] font-medium"
                        style={{ background: `${level?.color}22`, color: level?.color }}
                      >
                        {level?.label}
                      </span>
                    )}
                  </div>

                  {kp ? (
                    <>
                      <div className="flex items-end gap-2">
                        <span className="hud-value text-[24px] font-semibold leading-none text-cyan-100">
                          {kp.current.toFixed(2)}
                        </span>
                        <span className="text-[9px] text-slate-500">
                          / 24h 峰值 {kp.max24h.toFixed(2)}
                        </span>
                      </div>

                      <KpStrips samples={kp.samples} />

                      <p className="mt-1.5 text-[8.5px] text-slate-500">
                        {level?.description} · 极光可见南界约 {level?.viewlineLat}°
                        {viewlineNorth !== null ? `（实测 ${viewlineNorth}°N）` : ''}
                      </p>
                    </>
                  ) : kpError ? (
                    <p className="text-[8.5px] text-amber-300">{kpError}</p>
                  ) : (
                    <p className="text-[8.5px] text-slate-500">正在获取 Kp…</p>
                  )}
                </section>

                {/* calibrated legend */}
                <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                  <div className="mb-1 flex items-baseline justify-between">
                    <p className="hud-label">色阶（按当前峰值校准）</p>
                    <span className="hud-value text-[8.5px] text-slate-500">
                      峰值 {ramp.peak.toFixed(0)}%
                    </span>
                  </div>

                  <div className="space-y-1">
                    {auroraLegend(ramp).map((row) => (
                      <div key={row.label} className="flex items-center gap-2">
                        <span
                          className="h-2 w-8 shrink-0 rounded-sm"
                          style={{ background: row.color }}
                        />
                        <span className="w-[52px] shrink-0 text-[9px] text-slate-400">
                          {row.label}
                        </span>
                        <span className="hud-value text-[8.5px] text-slate-500">{row.range}</span>
                      </div>
                    ))}
                  </div>

                  <p className="mt-1.5 border-t border-white/5 pt-1.5 text-[8px] leading-relaxed text-slate-600">
                    SWPC 文档的 5–30% 绿 / &gt;60% 紫红描述的是磁暴条件。实测平静期峰值仅
                    {ramp.peak.toFixed(0)}% 且无任何格点超过 30%，固定阈值会让地图永远是一片均匀绿雾。
                    因此色阶按当前网格峰值自适应，图例显示真实概率数值。
                  </p>
                </section>

                {/* viewline */}
                <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                  <p className="hud-label mb-1">极光可见南界 Viewline</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[8px] text-slate-500">北半球</p>
                      <p className="hud-value text-[12px] text-emerald-300">
                        {viewlineNorth !== null ? `${viewlineNorth}°N` : '不可见'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[8px] text-slate-500">南半球</p>
                      <p className="hud-value text-[12px] text-emerald-300">
                        {viewlineSouth !== null ? `${Math.abs(viewlineSouth)}°S` : '不可见'}
                      </p>
                    </div>
                  </div>
                  <p className="mt-1 text-[8px] text-slate-600">
                    由网格中概率 ≥10% 的最高纬度行直接扫描得出，非 G 级近似。
                  </p>
                </section>

                {/* probe readout */}
                {probe ? (
                  <section className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-2.5">
                    <div className="flex items-center gap-1.5">
                      <MapPin size={9} className="text-emerald-400" />
                      <span className="hud-value text-[8.5px] text-slate-400">
                        {probe.lat.toFixed(2)}°, {probe.lng.toFixed(2)}°
                      </span>
                      <span className="hud-value ml-auto text-[13px] font-semibold text-emerald-200">
                        {localProbability !== null ? localProbability.toFixed(0) : '—'}
                        <span className="ml-0.5 text-[8.5px] font-normal text-emerald-400/70">%</span>
                      </span>
                    </div>
                    <p className="mt-0.5 text-[8px] text-slate-500">该点极光概率（双线性采样）</p>
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Horizontal Kp bar chart for the last ~24 h (8 three-hourly rows). */
function KpStrips({ samples }: { samples: { time: number; kp: number }[] }) {
  const recent = samples.slice(-8);

  const G_COLORS = ['#34d399', '#a3e635', '#facc15', '#f97316', '#f43f5e', '#a855f7'];

  const colorFor = (kp: number) => {
    const g = Math.min(5, Math.max(0, Math.floor(kp - 4)));
    return kp < 5 ? G_COLORS[0] : G_COLORS[g];
  };

  return (
    <div className="mt-1.5 flex items-end gap-[3px]">
      {recent.map((s, i) => {
        const height = Math.max(3, Math.min(28, (s.kp / 9) * 28));
        return (
          <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
            <div
              className="w-full rounded-sm transition-all"
              style={{ height: `${height}px`, background: colorFor(s.kp) }}
              title={`${s.kp.toFixed(2)} @ ${new Date(s.time).toISOString().slice(11, 16)}Z`}
            />
            <span className="hud-value text-[6.5px] text-slate-600">
              {new Date(s.time).getUTCHours().toString().padStart(2, '0')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
