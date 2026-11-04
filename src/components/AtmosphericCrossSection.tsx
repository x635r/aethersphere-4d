/**
 * AtmosphericCrossSection — the vertical slice viewport.
 *
 * Shows the transect the user drew on the globe: clouds, isotherms, jet streaks
 * and circulation arrows, plus a readout that follows the cursor. Hovering the
 * slice reports the corresponding lon/lat back to the map so the globe can show
 * the same point.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  Cloud,
  Thermometer,
  Wind,
  ArrowUpFromLine,
  RotateCw,
  MapPin,
} from 'lucide-react';
import {
  renderCrossSection,
  DEFAULT_SECTION_LAYOUT,
  DEFAULT_SECTION_THEME,
  type SectionLayout,
  type SectionRenderResult,
  sampleIndexForX,
  pressureForYSection,
} from '../render/crossSection';
import type { CrossSectionData } from '../data/sounding';
import { compassLabel } from '../core/geo';

export interface AtmosphericCrossSectionProps {
  open: boolean;
  onClose: () => void;
  data: CrossSectionData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Reports the hovered along-track point to the map for synchronized highlight. */
  onHoverPoint?: (point: { lng: number; lat: number } | null) => void;
  timeMs: number;
}

interface HoverState {
  index: number;
  pressure: number;
}

export function AtmosphericCrossSection({
  open,
  onClose,
  data,
  loading,
  error,
  onRetry,
  onHoverPoint,
  timeMs,
}: AtmosphericCrossSectionProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [layout, setLayout] = useState<SectionLayout>(DEFAULT_SECTION_LAYOUT);
  const [result, setResult] = useState<SectionRenderResult | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const [showClouds, setShowClouds] = useState(true);
  const [showTemperature, setShowTemperature] = useState(true);
  const [showJets, setShowJets] = useState(true);
  const [showCirculation, setShowCirculation] = useState(true);

  /* ---------------- responsive layout ---------------- */
  useEffect(() => {
    if (!open) return;

    const compute = () => {
      const w = Math.min(window.innerWidth - 48, 1280);
      const h = Math.max(320, Math.min(window.innerHeight * 0.56, 520));
      setLayout({
        ...DEFAULT_SECTION_LAYOUT,
        width: w,
        height: h,
      });
    };

    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  /* ---------------- draw ---------------- */
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(layout.width * ratio);
    canvas.height = Math.round(layout.height * ratio);
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;

    const stats = renderCrossSection(ctx, {
      data,
      layout,
      theme: DEFAULT_SECTION_THEME,
      pixelRatio: ratio,
      highlightIndex: hover?.index ?? null,
      showClouds,
      showTemperature,
      showJets,
      showCirculation,
    });

    setResult(stats);
  }, [open, data, layout, hover, showClouds, showTemperature, showJets, showCirculation]);

  /* ---------------- hover ---------------- */
  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !data) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (
        x < layout.padding.left ||
        x > layout.width - layout.padding.right ||
        y < layout.padding.top ||
        y > layout.height - layout.padding.bottom
      ) {
        setHover(null);
        onHoverPoint?.(null);
        return;
      }

      const index = sampleIndexForX(x, data.samples, data.lengthKm, layout);
      const pressure = pressureForYSection(y, layout);

      setHover({ index, pressure });

      const sample = data.samples[index];
      if (sample) onHoverPoint?.({ lng: sample.lng, lat: sample.lat });
    },
    [data, layout, onHoverPoint],
  );

  const handleLeave = useCallback(() => {
    setHover(null);
    onHoverPoint?.(null);
  }, [onHoverPoint]);

  const hoveredSample = hover && data ? data.samples[hover.index] : null;
  const hoveredLevelIndex =
    hover && data
      ? data.levels.reduce(
          (best, level, i) =>
            Math.abs(Math.log(level) - Math.log(hover.pressure)) <
            Math.abs(Math.log(data.levels[best]) - Math.log(hover.pressure))
              ? i
              : best,
          0,
        )
      : -1;

  const stamp = useMemo(
    () => new Date(timeMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z',
    [timeMs],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center">
      <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden />

      <div className="hud-panel relative mb-3 flex max-h-[92vh] w-full max-w-[1320px] flex-col overflow-hidden rounded-2xl">
        {/* header */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cyan-500/15 px-4 py-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-fuchsia-400/15">
            <ArrowUpFromLine size={13} className="text-fuchsia-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              大气垂直剖面舱 · Cross-Section
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {data
                ? `${data.lengthKm.toFixed(0)} km · ${data.samples.length} 点 · ${data.levels.length} 层 · ${stamp}`
                : '等待剖面数据'}
            </p>
          </div>

          {/* layer toggles */}
          <div className="ml-2 flex flex-wrap items-center gap-1">
            <Toggle active={showTemperature} onClick={() => setShowTemperature((v) => !v)} icon={Thermometer} label="温度" />
            <Toggle active={showClouds} onClick={() => setShowClouds((v) => !v)} icon={Cloud} label="云团" />
            <Toggle active={showJets} onClick={() => setShowJets((v) => !v)} icon={Wind} label="急流" />
            <Toggle active={showCirculation} onClick={() => setShowCirculation((v) => !v)} icon={ArrowUpFromLine} label="环流" />
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

        {/* canvas */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center p-2">
          {loading ? (
            <div className="flex h-[300px] w-full flex-col items-center justify-center gap-3">
              <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
              <p className="text-[11px] text-slate-400">沿大圆路径采样并拉取 15 层剖面数据…</p>
            </div>
          ) : error ? (
            <div className="flex h-[300px] w-full flex-col items-center justify-center gap-3 px-8 text-center">
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
              ref={canvasRef}
              onMouseMove={handleMove}
              onMouseLeave={handleLeave}
              className="cursor-crosshair rounded-md"
            />
          )}
        </div>

        {/* footer readout */}
        <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-cyan-500/10 px-4 py-1.5">
          {hoveredSample && hoveredLevelIndex >= 0 ? (
            <>
              <Readout
                icon={MapPin}
                label="位置"
                value={`${hoveredSample.lat.toFixed(2)}°, ${hoveredSample.lng.toFixed(2)}°`}
                color="#22d3ee"
              />
              <Readout
                icon={Thermometer}
                label={`${data?.levels[hoveredLevelIndex].toFixed(0)} hPa`}
                value={`${fmt(hoveredSample.temperature[hoveredLevelIndex], 1)} °C`}
                color="#f87171"
              />
              <Readout
                icon={Cloud}
                label="RH / 云量"
                value={`${fmt(hoveredSample.relativeHumidity[hoveredLevelIndex], 0)}% / ${fmt(hoveredSample.cloudCover[hoveredLevelIndex], 0)}%`}
                color="#e2e8f0"
              />
              <Readout
                icon={Wind}
                label="风"
                value={`${fmt(hoveredSample.windSpeed[hoveredLevelIndex], 1)} m/s ${compassLabel(hoveredSample.windDirection[hoveredLevelIndex] ?? 0)}`}
                color="#a5b4fc"
              />
              <Readout
                icon={ArrowUpFromLine}
                label="ω"
                value={`${fmt(hoveredSample.verticalVelocity[hoveredLevelIndex], 2)} Pa/s`}
                color={
                  (hoveredSample.verticalVelocity[hoveredLevelIndex] ?? 0) < 0
                    ? '#34d399'
                    : '#fb7185'
                }
              />
            </>
          ) : (
            <p className="text-[9px] text-slate-600">
              将指针移入剖面读取该点的温度、湿度、风与垂直速度；地球上的对应位置会同步高亮。
            </p>
          )}

          {result ? (
            <div className="ml-auto flex items-center gap-3 text-[8.5px] text-slate-500">
              <span>
                温度{' '}
                <span className="hud-value text-rose-300/90">
                  {result.temperatureRange.min.toFixed(0)}…{result.temperatureRange.max.toFixed(0)} °C
                </span>
              </span>
              <span>
                最大风速{' '}
                <span className="hud-value text-indigo-300/90">
                  {result.maxWindSpeed.toFixed(0)} m/s
                </span>
              </span>
              <span>
                急流覆盖{' '}
                <span className="hud-value text-fuchsia-300/90">
                  {(result.jetCoverage * 100).toFixed(0)}%
                </span>
              </span>
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                       */
/* ------------------------------------------------------------------ */

function fmt(v: number | undefined, digits: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function Toggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Wind;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
        active
          ? 'bg-cyan-400/15 text-cyan-200'
          : 'text-slate-500 hover:bg-white/5 hover:text-slate-300',
      ].join(' ')}
    >
      <Icon size={9} />
      {label}
    </button>
  );
}

function Readout({
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
    <div className="flex items-center gap-1">
      <Icon size={9} className="text-slate-600" />
      <span className="text-[8.5px] text-slate-500">{label}</span>
      <span className="hud-value text-[9.5px]" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
