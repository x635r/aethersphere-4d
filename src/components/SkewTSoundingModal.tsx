/**
 * SkewTSoundingModal — the interactive sounding panel.
 *
 * Renders the skew-T and hodograph to canvases via the pure renderers in
 * `render/skewT.ts`, and derives every number on screen from the same
 * `computeSoundingDiagnostics` call the plot used. Nothing here re-implements
 * thermodynamics; it only formats.
 *
 * Hovering the plot highlights the nearest level and shows its exact values,
 * which is what makes the diagram readable rather than merely pretty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  Wind,
  Thermometer,
  Droplets,
  Cloud,
  ArrowUpFromLine,
  RotateCw,
} from 'lucide-react';
import {
  renderSkewT,
  renderHodograph,
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  type SkewTLayout,
  type SkewTRenderResult,
} from '../render/skewT';
import type { SoundingProfile } from '../data/sounding';
import type { SoundingLevel, SoundingDiagnostics } from '../utils/thermodynamics';
import { yForPressure } from '../render/skewT';
import { compassLabel, compassLabelZh } from '../core/geo';

export interface SkewTSoundingModalProps {
  open: boolean;
  onClose: () => void;
  profile: SoundingProfile | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** UTC epoch ms currently displayed. */
  timeMs: number;
}

interface HodographStats {
  srh: number;
  bulkShear: number;
  stormU: number;
  stormV: number;
}

export function SkewTSoundingModal({
  open,
  onClose,
  profile,
  loading,
  error,
  onRetry,
  timeMs,
}: SkewTSoundingModalProps) {
  const skewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hodoCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [hover, setHover] = useState<SoundingLevel | null>(null);
  const [renderResult, setRenderResult] = useState<SkewTRenderResult | null>(null);
  const [hodoStats, setHodoStats] = useState<HodographStats | null>(null);

  // Layout is responsive: the modal is wide, but never wider than the viewport.
  const [layout, setLayout] = useState<SkewTLayout>(DEFAULT_LAYOUT);

  useEffect(() => {
    if (!open) return;

    const compute = () => {
      const availW = Math.min(window.innerWidth - 96, 1180);
      // Left column gets the chart; the right rail is fixed.
      const chartW = Math.max(420, Math.min(660, availW - 300));
      const chartH = Math.max(460, Math.min(window.innerHeight - 220, 660));
      setLayout({
        ...DEFAULT_LAYOUT,
        width: chartW,
        height: chartH,
      });
    };

    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  /* ---------------- draw the skew-T ---------------- */
  useEffect(() => {
    if (!open) return;
    const canvas = skewCanvasRef.current;
    if (!canvas || !profile || profile.levels.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(layout.width * ratio);
    canvas.height = Math.round(layout.height * ratio);
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;

    const result = renderSkewT(ctx, {
      levels: profile.levels,
      layout,
      theme: DEFAULT_THEME,
      pixelRatio: ratio,
    });

    setRenderResult(result);
  }, [open, profile, layout]);

  /* ---------------- draw the hodograph ---------------- */
  useEffect(() => {
    if (!open || !renderResult) return;
    const canvas = hodoCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = 176;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const stats = renderHodograph(ctx, {
      samples: renderResult.hodograph,
      size,
      pixelRatio: ratio,
    });

    setHodoStats({
      srh: stats.srh,
      bulkShear: stats.bulkShear,
      stormU: stats.storm.u,
      stormV: stats.storm.v,
    });
  }, [open, renderResult]);

  /* ---------------- hover hit-testing ---------------- */
  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = skewCanvasRef.current;
      if (!canvas || !profile) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Nearest level by vertical distance; the pressure axis is monotonic in y.
      let best: SoundingLevel | null = null;
      let bestDist = Infinity;

      for (const level of profile.levels) {
        // Use the same projection the renderer draws with, so hovering picks
        // the level whose marker is actually under the cursor.
        const ly = yForPressure(level.pressure, layout);
        const dist = Math.abs(ly - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = level;
        }
      }

      if (best && bestDist < 26 && x > layout.padding.left && x < layout.width - layout.padding.right) {
        setHover(best);
      } else {
        setHover(null);
      }
    },
    [profile, layout],
  );

  const diagnostics = renderResult?.diagnostics ?? null;

  const stamp = useMemo(() => {
    const d = new Date(timeMs);
    return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  }, [timeMs]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div className="hud-panel relative flex max-h-[94vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-2xl">
        {/* header */}
        <header className="flex shrink-0 items-center gap-3 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-400/15">
            <Thermometer size={13} className="text-amber-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              虚拟探空气球 · Skew-T Log-P
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {profile
                ? `${profile.latitude.toFixed(2)}°, ${profile.longitude.toFixed(2)}° · 海拔 ${profile.elevation.toFixed(0)} m · ${stamp}`
                : '等待探空数据'}
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

        {/* body */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
          {/* chart column */}
          <div className="relative flex min-w-0 flex-1 items-start justify-center p-3">
            {loading ? (
              <div className="flex h-[420px] w-full flex-col items-center justify-center gap-3">
                <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
                <p className="text-[11px] text-slate-400">正在拉取 19 层等压面廓线…</p>
              </div>
            ) : error ? (
              <div className="flex h-[420px] w-full flex-col items-center justify-center gap-3 px-8 text-center">
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
            ) : (
              <canvas
                ref={skewCanvasRef}
                onMouseMove={handleMove}
                onMouseLeave={() => setHover(null)}
                className="cursor-crosshair rounded-md"
              />
            )}
          </div>

          {/* right rail */}
          <aside className="w-full shrink-0 space-y-2.5 border-t border-cyan-500/10 p-3 lg:w-[300px] lg:border-l lg:border-t-0">
            {hover ? (
              <HoverCard level={hover} />
            ) : (
              <DiagnosticsCard diagnostics={diagnostics} />
            )}

            <IndexGrid diagnostics={diagnostics} />

            {/* hodograph */}
            <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2">
              <div className="mb-1 flex items-baseline justify-between">
                <p className="hud-label">风速矢端图 Hodograph</p>
                {hodoStats ? (
                  <span className="hud-value text-[8.5px] text-cyan-400/80">
                    SRH {hodoStats.srh.toFixed(0)}
                  </span>
                ) : null}
              </div>
              <div className="flex justify-center">
                <canvas ref={hodoCanvasRef} className="rounded" />
              </div>
              {hodoStats ? (
                <div className="mt-1 flex items-center justify-between text-[8px] text-slate-500">
                  <span>
                    0–6km 切变{' '}
                    <span className="hud-value text-slate-300">
                      {hodoStats.bulkShear.toFixed(1)} m/s
                    </span>
                  </span>
                  <span>
                    风暴移动{' '}
                    <span className="hud-value text-amber-300/90">
                      {Math.hypot(hodoStats.stormU, hodoStats.stormV).toFixed(0)} m/s
                    </span>
                  </span>
                </div>
              ) : null}
            </section>

            <LevelTable levels={profile?.levels ?? []} />
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                     */
/* ------------------------------------------------------------------ */

function HoverCard({ level }: { level: SoundingLevel }) {
  return (
    <section className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.07] p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="hud-value text-[12px] font-semibold text-cyan-200">
          {level.pressure.toFixed(0)} hPa
        </p>
        <span className="hud-value text-[9px] text-slate-400">
          {(level.height / 1000).toFixed(2)} km
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[9px]">
        <Row label="温度" value={`${level.temperature.toFixed(1)}°C`} color="#f87171" />
        <Row label="露点" value={`${level.dewPoint.toFixed(1)}°C`} color="#4ade80" />
        <Row
          label="露点差"
          value={`${(level.temperature - level.dewPoint).toFixed(1)}°C`}
          color="#94a3b8"
        />
        <Row
          label="相对湿度"
          value={
            Number.isFinite(level.relativeHumidity ?? NaN)
              ? `${(level.relativeHumidity as number).toFixed(0)}%`
              : '—'
          }
          color="#38bdf8"
        />
        <Row label="风速" value={`${level.windSpeed.toFixed(1)} m/s`} color="#a5b4fc" />
        <Row
          label="风向"
          value={`${level.windDirection.toFixed(0)}° ${compassLabel(level.windDirection)}`}
          color="#a5b4fc"
        />
        <Row
          label="云量"
          value={
            Number.isFinite(level.cloudCover ?? NaN)
              ? `${(level.cloudCover as number).toFixed(0)}%`
              : '—'
          }
          color="#cbd5e1"
        />
        <Row
          label="垂直速度"
          value={
            Number.isFinite(level.verticalVelocity ?? NaN)
              ? `${(level.verticalVelocity as number).toFixed(2)} Pa/s`
              : '—'
          }
          color="#fbbf24"
        />
      </div>
    </section>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="text-slate-500">{label}</span>
      <span className="hud-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function DiagnosticsCard({ diagnostics }: { diagnostics: SoundingDiagnostics | null }) {
  if (!diagnostics) {
    return (
      <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
        <p className="text-[9px] text-slate-500">等待廓线数据…</p>
      </section>
    );
  }

  const sev = diagnostics.severity;

  return (
    <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="hud-label">热力学诊断</p>
        <span
          className="rounded px-1.5 py-0.5 text-[8.5px] font-medium"
          style={{ background: `${sev.color}22`, color: sev.color }}
        >
          {sev.label}
        </span>
      </div>

      <div className="space-y-1 text-[9.5px]">
        <Metric
          icon={Cloud}
          label="CAPE"
          value={`${diagnostics.cape.toFixed(0)} J/kg`}
          color={diagnostics.cape > 1000 ? '#f97316' : '#94a3b8'}
        />
        <Metric
          icon={ArrowUpFromLine}
          label="CIN"
          value={
            Number.isFinite(diagnostics.cin)
              ? `${diagnostics.cin.toFixed(0)} J/kg`
              : '无自由对流'
          }
          color={
            Number.isFinite(diagnostics.cin) && diagnostics.cin < -50
              ? '#22d3ee'
              : '#64748b'
          }
        />
        <Metric
          icon={Droplets}
          label="LCL 抬升凝结高度"
          value={
            Number.isFinite(diagnostics.lclHeight)
              ? `${diagnostics.lclHeight.toFixed(0)} m / ${diagnostics.lclPressure.toFixed(0)} hPa`
              : '—'
          }
          color="#fbbf24"
        />
        <Metric
          icon={Thermometer}
          label="0°C 零度层"
          value={
            Number.isFinite(diagnostics.freezingLevel)
              ? `${diagnostics.freezingLevel.toFixed(0)} m`
              : '未穿越'
          }
          color="#7dd3fc"
        />
        <Metric
          icon={Wind}
          label="LI 抬升指数"
          value={
            Number.isFinite(diagnostics.liftedIndex)
              ? `${diagnostics.liftedIndex.toFixed(1)} °C`
              : '—'
          }
          color={
            Number.isFinite(diagnostics.liftedIndex)
              ? diagnostics.liftedIndex < -4
                ? '#f97316'
                : '#94a3b8'
              : '#64748b'
          }
        />
      </div>

      {sev.note ? (
        <p className="mt-1.5 border-t border-white/5 pt-1.5 text-[8px] text-slate-500">
          {sev.note}
        </p>
      ) : null}
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Wind;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="flex min-w-0 items-center gap-1 text-slate-500">
        <Icon size={9} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className="hud-value shrink-0" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function IndexGrid({ diagnostics }: { diagnostics: SoundingDiagnostics | null }) {
  if (!diagnostics) return null;

  const items = [
    { label: 'K 指数', value: diagnostics.kIndex, unit: '°C', warn: 30 },
    { label: 'Total Totals', value: diagnostics.totalTotals, unit: '°C', warn: 50 },
    { label: 'Showalter', value: diagnostics.showalter, unit: '°C', warn: 0 },
    { label: 'LCL 温度', value: diagnostics.lclTemperature, unit: '°C', warn: null },
  ];

  return (
    <section className="grid grid-cols-2 gap-1.5">
      {items.map((item) => {
        const finite = Number.isFinite(item.value);
        const hot = finite && item.warn !== null && item.value > (item.warn as number);
        return (
          <div
            key={item.label}
            className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5"
          >
            <p className="text-[8px] uppercase tracking-wider text-slate-500">{item.label}</p>
            <p
              className="hud-value text-[12px] font-medium"
              style={{ color: hot ? '#fb923c' : '#e2e8f0' }}
            >
              {finite ? item.value.toFixed(1) : '—'}
              <span className="ml-0.5 text-[8px] font-normal text-slate-500">{item.unit}</span>
            </p>
          </div>
        );
      })}
    </section>
  );
}

function LevelTable({ levels }: { levels: SoundingLevel[] }) {
  const [expanded, setExpanded] = useState(false);
  if (levels.length === 0) return null;

  const rows = expanded ? levels : levels.slice(0, 8);

  return (
    <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="hud-label">层结数据</p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[8.5px] text-cyan-400/80 hover:text-cyan-300"
        >
          {expanded ? '收起' : `全部 ${levels.length} 层`}
        </button>
      </div>

      <div className="max-h-[168px] overflow-y-auto">
        <table className="w-full text-[8.5px]">
          <thead className="sticky top-0 bg-slate-950/80 text-slate-600">
            <tr>
              <th className="py-0.5 text-left font-normal">hPa</th>
              <th className="py-0.5 text-right font-normal">T</th>
              <th className="py-0.5 text-right font-normal">Td</th>
              <th className="py-0.5 text-right font-normal">km</th>
              <th className="py-0.5 text-right font-normal">风</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={`${l.pressure}-${i}`} className="border-t border-white/[0.04]">
                <td className="hud-value py-0.5 text-slate-400">{l.pressure.toFixed(0)}</td>
                <td className="hud-value py-0.5 text-right text-rose-300/90">
                  {l.temperature.toFixed(1)}
                </td>
                <td className="hud-value py-0.5 text-right text-emerald-300/90">
                  {l.dewPoint.toFixed(1)}
                </td>
                <td className="hud-value py-0.5 text-right text-slate-500">
                  {(l.height / 1000).toFixed(1)}
                </td>
                <td className="hud-value py-0.5 text-right text-indigo-300/80">
                  {l.windSpeed.toFixed(0)}
                  <span className="ml-0.5 text-slate-600">{compassLabelZh(l.windDirection)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
