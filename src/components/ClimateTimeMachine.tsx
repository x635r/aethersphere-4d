/**
 * ClimateTimeMachine — ERA5 reanalysis viewer with Hawkins warming stripes.
 *
 * Two linked views:
 *   1. A single-day record for any date since 1940, with one-click jumps to
 *      documented historical extremes.
 *   2. The 85-year annual anomaly series rendered as warming stripes plus a
 *      histogram, with the trend stated in numbers.
 *
 * The stripes are computed from monthly→annual aggregation of ERA5's own daily
 * values; no pre-baked climate graphics are shipped.
 */

import { useMemo } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  RotateCw,
  Thermometer,
  Calendar,
  TrendingUp,
  Droplets,
  Wind,
} from 'lucide-react';
import type { ClimateSeries, DailyRecord, StripeData } from '../data/climate';
import { HISTORICAL_EVENTS, stripeColor } from '../data/climate';

export interface ClimateTimeMachineProps {
  open: boolean;
  onClose: () => void;

  /** Point being analysed (from the probe or a preset). */
  point: { lat: number; lng: number } | null;

  daily: DailyRecord | null;
  dailyLoading: boolean;
  dailyError: string | null;
  selectedDate: string;
  onDateChange: (date: string) => void;
  onRetryDaily: () => void;
  onJumpToEvent: (eventId: string) => void;

  series: ClimateSeries | null;
  stripes: StripeData | null;
  seriesLoading: boolean;
  seriesError: string | null;
  onRetrySeries: () => void;
  /** Whole-record span used for the fetch. */
  span: { from: number; to: number };
}

export function ClimateTimeMachine(props: ClimateTimeMachineProps) {
  const {
    open,
    onClose,
    point,
    daily,
    dailyLoading,
    dailyError,
    selectedDate,
    onDateChange,
    onRetryDaily,
    onJumpToEvent,
    series,
    stripes,
    seriesLoading,
    seriesError,
    onRetrySeries,
    span,
  } = props;

  const anomalyColor = useMemo(() => {
    if (!stripes) return '#94a3b8';
    const latest = stripes.latest;
    if (!latest) return '#94a3b8';
    const t = (latest.anomaly - stripes.minAnomaly) / Math.max(1e-6, stripes.maxAnomaly - stripes.minAnomaly);
    return stripeColor(t);
  }, [stripes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/82 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[93vh] w-full max-w-[1020px] flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-400/15">
            <Calendar size={13} className="text-sky-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              ERA5 气候时间机
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {point
                ? `${point.lat.toFixed(2)}°, ${point.lng.toFixed(2)}° · ERA5 再分析 ${span.from}–${span.to}`
                : '在探针模式下选择位置'}
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
          {!point ? (
            <div className="flex h-[260px] flex-col items-center justify-center gap-2">
              <p className="text-[11px] text-slate-500">
                切换到探针模式并在地球上悬停，或使用下方预设城市
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* ---- single day ---- */}
              <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <p className="hud-label">指定日期实况</p>
                  <input
                    type="date"
                    value={selectedDate}
                    min={`${span.from}-01-01`}
                    max={`${span.to}-12-31`}
                    onChange={(e) => onDateChange(e.target.value)}
                    className="rounded border border-white/10 bg-slate-900/80 px-1.5 py-0.5 text-[9.5px] text-slate-200 outline-none focus:border-cyan-500/40"
                  />
                  <button
                    type="button"
                    onClick={onRetryDaily}
                    disabled={dailyLoading}
                    className="flex items-center gap-1 rounded border border-cyan-500/25 px-1.5 py-0.5 text-[8.5px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
                  >
                    <RotateCw size={8} className={dailyLoading ? 'animate-aether-spin' : ''} />
                    查询
                  </button>
                </div>

                {dailyLoading ? (
                  <div className="flex h-16 items-center justify-center gap-2">
                    <Loader2 size={14} className="animate-aether-spin text-cyan-400" />
                    <span className="text-[9.5px] text-slate-400">正在读取 ERA5 当日值…</span>
                  </div>
                ) : dailyError ? (
                  <p className="flex items-center gap-1 text-[9px] text-amber-300">
                    <AlertTriangle size={9} />
                    {dailyError}
                  </p>
                ) : daily ? (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                    <DayStat
                      icon={Thermometer}
                      label="日均温"
                      value={fmtNum(daily.tempMean, 1)}
                      unit="°C"
                      color="#f87171"
                    />
                    <DayStat
                      icon={TrendingUp}
                      label="最高"
                      value={fmtNum(daily.tempMax, 1)}
                      unit="°C"
                      color="#fb923c"
                    />
                    <DayStat
                      icon={Thermometer}
                      label="最低"
                      value={fmtNum(daily.tempMin, 1)}
                      unit="°C"
                      color="#60a5fa"
                    />
                    <DayStat
                      icon={Droplets}
                      label="降水"
                      value={fmtNum(daily.precipitation, 1)}
                      unit="mm"
                      color="#22d3ee"
                    />
                    <DayStat
                      icon={Wind}
                      label="最大风"
                      value={daily.windMax !== null ? fmtNum(daily.windMax * 3.6, 1) : '—'}
                      unit="km/h"
                      color="#a78bfa"
                    />
                  </div>
                ) : null}

                {/* historical event shortcuts */}
                <div className="mt-1.5 flex flex-wrap gap-1 border-t border-white/5 pt-1.5">
                  {HISTORICAL_EVENTS.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => onJumpToEvent(ev.id)}
                      title={`${ev.date} · ${ev.note}`}
                      className="rounded border border-white/10 px-1.5 py-0.5 text-[8.5px] text-slate-400 transition-colors hover:border-cyan-500/30 hover:text-cyan-300"
                    >
                      {ev.label}
                    </button>
                  ))}
                </div>
              </section>

              {/* ---- warming stripes ---- */}
              <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-1">
                  <p className="hud-label">气候变暖条纹 · Warming Stripes</p>
                  {series ? (
                    <span className="hud-value text-[8.5px] text-slate-500">
                      基线 {series.baselineWindow[0]}–{series.baselineWindow[1]} = {series.baseline.toFixed(2)} °C
                    </span>
                  ) : null}
                </div>

                {seriesLoading ? (
                  <div className="flex h-[120px] items-center justify-center gap-2">
                    <Loader2 size={14} className="animate-aether-spin text-cyan-400" />
                    <span className="text-[9.5px] text-slate-400">
                      正在拉取 {span.to - span.from + 1} 年逐日记录…
                    </span>
                  </div>
                ) : seriesError ? (
                  <div className="flex h-[120px] flex-col items-center justify-center gap-1.5">
                    <AlertTriangle size={16} className="text-amber-400" />
                    <p className="text-[9px] text-amber-300">{seriesError}</p>
                    <button
                      type="button"
                      onClick={onRetrySeries}
                      className="rounded bg-amber-500/15 px-2 py-0.5 text-[8.5px] text-amber-200"
                    >
                      重试
                    </button>
                  </div>
                ) : stripes ? (
                  <>
                    <StripesChart stripes={stripes} />

                    <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      <MiniStat
                        label="最暖年"
                        value={stripes.latest ? `${stripes.latest.year}` : '—'}
                        unit={stripes.latest ? `${stripes.latest.anomaly >= 0 ? '+' : ''}${stripes.latest.anomaly.toFixed(2)} °C` : ''}
                        color={anomalyColor}
                      />
                      <MiniStat
                        label="首十年均值"
                        value={
                          stripes.firstDecadeMean !== null
                            ? `${stripes.firstDecadeMean >= 0 ? '+' : ''}${stripes.firstDecadeMean.toFixed(2)}`
                            : '—'
                        }
                        unit="°C 距平"
                        color="#60a5fa"
                      />
                      <MiniStat
                        label="末十年均值"
                        value={
                          stripes.lastDecadeMean !== null
                            ? `${stripes.lastDecadeMean >= 0 ? '+' : ''}${stripes.lastDecadeMean.toFixed(2)}`
                            : '—'
                        }
                        unit="°C 距平"
                        color="#f87171"
                      />
                      <MiniStat
                        label="净增温"
                        value={
                          stripes.firstDecadeMean !== null && stripes.lastDecadeMean !== null
                            ? `${(stripes.lastDecadeMean - stripes.firstDecadeMean >= 0 ? '+' : '')}${(
                                stripes.lastDecadeMean - stripes.firstDecadeMean
                              ).toFixed(2)}`
                            : '—'
                        }
                        unit="°C"
                        color="#fbbf24"
                      />
                    </div>

                    <AnomalyHistogram stripes={stripes} />

                    <p className="mt-1.5 border-t border-white/5 pt-1.5 text-[8px] leading-relaxed text-slate-600">
                      年度均温由 ERA5 逐日值聚合（全年日值等权平均）。距平相对
                      {series?.baselineWindow[0]}–{series?.baselineWindow[1]} 基线。
                      {stripes.incompleteYears.length > 0
                        ? ` ${stripes.incompleteYears.length} 个不完整年份已从色阶范围中排除：${stripes.incompleteYears.slice(0, 6).join('、')}${stripes.incompleteYears.length > 6 ? '…' : ''}`
                        : ''}
                    </p>
                  </>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Charts                                                             */
/* ------------------------------------------------------------------ */

/** The stripes themselves: one 1px-wide rect per year. */
function StripesChart({ stripes }: { stripes: StripeData }) {
  const width = 940;
  const height = 92;
  const pad = { left: 6, right: 6, top: 6, bottom: 14 };

  const usable = width - pad.left - pad.right;
  const barWidth = usable / Math.max(1, stripes.stripes.length);

  const first = stripes.stripes[0]?.year;
  const last = stripes.stripes[stripes.stripes.length - 1]?.year;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height: 'auto' }}>
      {stripes.stripes.map((s, i) => {
        // Incomplete years get a hatched/dimmed look instead of a full colour,
        // so a partial year cannot masquerade as a strong anomaly.
        const fill =
          s.anomaly === null
            ? 'rgba(30,41,59,0.85)'
            : s.months < 12
              ? 'rgba(71,85,105,0.6)'
              : stripeColor(s.normalised);

        return (
          <rect
            key={s.year}
            x={pad.left + i * barWidth}
            y={pad.top}
            width={Math.max(1, barWidth + 0.4)}
            height={height - pad.top - pad.bottom}
            fill={fill}
          />
        );
      })}

      <text x={pad.left} y={height - 3} fontSize={7} fill="rgba(148,163,184,0.7)">
        {first}
      </text>
      <text x={width - pad.right} y={height - 3} fontSize={7} textAnchor="end" fill="rgba(148,163,184,0.7)">
        {last}
      </text>
    </svg>
  );
}

/** Histogram of annual anomalies, showing whether the distribution shifted. */
function AnomalyHistogram({ stripes }: { stripes: StripeData }) {
  const width = 940;
  const height = 70;
  const pad = { left: 8, right: 8, top: 6, bottom: 12 };

  const bins = 24;
  const span = stripes.maxAnomaly - stripes.minAnomaly || 1;
  const counts = new Array<number>(bins).fill(0);
  let total = 0;

  for (const s of stripes.stripes) {
    if (s.anomaly === null || s.months < 12) continue;
    const t = (s.anomaly - stripes.minAnomaly) / span;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
    counts[bin] += 1;
    total += 1;
  }

  const maxCount = Math.max(1, ...counts);
  const usable = width - pad.left - pad.right;
  const barWidth = usable / bins;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 block w-full" style={{ height: 'auto' }}>
      {counts.map((c, i) => {
        const frac = c / maxCount;
        const h = frac * (height - pad.top - pad.bottom);
        const centre = (i + 0.5) / bins;

        return (
          <rect
            key={i}
            x={pad.left + i * barWidth}
            y={height - pad.bottom - h}
            width={Math.max(1, barWidth - 1)}
            height={h}
            fill={stripeColor(centre)}
          />
        );
      })}

      <text x={pad.left} y={height - 2} fontSize={6.5} fill="rgba(148,163,184,0.6)">
        {stripes.minAnomaly.toFixed(1)}°C
      </text>
      <text x={width - pad.right} y={height - 2} fontSize={6.5} textAnchor="end" fill="rgba(148,163,184,0.6)">
        {stripes.maxAnomaly.toFixed(1)}°C
      </text>
      <text x={width / 2} y={height - 2} fontSize={6.5} textAnchor="middle" fill="rgba(148,163,184,0.45)">
        年温度距平分布（{total} 年）
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Small components                                                   */
/* ------------------------------------------------------------------ */

function DayStat({
  icon: Icon,
  label,
  value,
  unit,
  color,
}: {
  icon: typeof Thermometer;
  label: string;
  value: string;
  unit: string;
  color: string;
}) {
  return (
    <div className="rounded border border-white/5 bg-white/[0.03] px-1.5 py-1">
      <p className="flex items-center gap-1 text-[7.5px] uppercase tracking-wider text-slate-500">
        <Icon size={7} />
        {label}
      </p>
      <p className="hud-value text-[13px] font-semibold" style={{ color }}>
        {value}
      </p>
      <p className="text-[7px] text-slate-600">{unit}</p>
    </div>
  );
}

function MiniStat({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  color: string;
}) {
  return (
    <div className="rounded border border-white/5 bg-white/[0.03] px-1.5 py-1">
      <p className="text-[7.5px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="hud-value text-[12px] font-semibold" style={{ color }}>
        {value}
      </p>
      <p className="text-[7px] text-slate-600">{unit}</p>
    </div>
  );
}

function fmtNum(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}
