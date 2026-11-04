/**
 * RadarAndChem — the L2 control panel.
 *
 * Hosts three independent data products behind one surface:
 *   - RainViewer precipitation radar (animated past 2 h),
 *   - CAMS chemistry fields (PM2.5 / dust / AOD / UV),
 *   - the nearest-point AQ diagnostic readout.
 *
 * The radar animation runs on its own clock and cross-fades between two
 * MapLibre raster slots, so it keeps looping while the main timeline sits still.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  Play,
  Pause,
  Radar,
  Cloud,
  Wind,
  Sun,
  RotateCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import {
  CHEM_VARIABLES,
  aqiBand,
  type ChemField,
  type ChemPoint,
  type ChemVariableId,
  type RadarMetadata,
} from '../data/stage3';
import { chemLegendRows } from '../layers/stage3Layers';

export interface RadarAndChemProps {
  open: boolean;
  onClose: () => void;

  radar: RadarMetadata | null;
  radarLoading: boolean;
  radarError: string | null;
  radarFrameIndex: number;
  onRadarFrameChange: (i: number) => void;
  radarPlaying: boolean;
  onToggleRadarPlay: () => void;
  radarVisible: boolean;
  onToggleRadarVisible: () => void;
  onRetryRadar: () => void;

  chemVariable: ChemVariableId;
  onChemVariableChange: (v: ChemVariableId) => void;
  chemField: ChemField | null;
  chemLoading: boolean;
  chemError: string | null;
  chemVisible: boolean;
  onToggleChemVisible: () => void;
  chemOpacity: number;
  onChemOpacityChange: (v: number) => void;
  onRetryChem: () => void;

  chemPoint: ChemPoint | null;
  pointLabel: string | null;
}

const VARIABLE_ICONS: Record<ChemVariableId, typeof Wind> = {
  pm2_5: Cloud,
  dust: Wind,
  aerosol_optical_depth: Cloud,
  uv_index: Sun,
};

export function RadarAndChem(props: RadarAndChemProps) {
  const {
    open,
    onClose,
    radar,
    radarLoading,
    radarError,
    radarFrameIndex,
    onRadarFrameChange,
    radarPlaying,
    onToggleRadarPlay,
    radarVisible,
    onToggleRadarVisible,
    onRetryRadar,
    chemVariable,
    onChemVariableChange,
    chemField,
    chemLoading,
    chemError,
    chemVisible,
    onToggleChemVisible,
    chemOpacity,
    onChemOpacityChange,
    onRetryChem,
    chemPoint,
    pointLabel,
  } = props;

  const [tab, setTab] = useState<'radar' | 'chem'>('radar');

  const frames = radar?.past ?? [];
  const currentFrame = frames[Math.min(radarFrameIndex, Math.max(0, frames.length - 1))];

  /* ---------------- radar self-animation ---------------- */
  const rafRef = useRef(0);
  const lastRef = useRef(0);

  useEffect(() => {
    if (!radarPlaying || frames.length < 2) return;

    lastRef.current = performance.now();

    const tick = () => {
      const now = performance.now();
      // One frame every 420 ms — slow enough to read the echo motion.
      if (now - lastRef.current > 420) {
        lastRef.current = now;
        const next = (radarFrameIndex + 1) % frames.length;
        onRadarFrameChange(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [radarPlaying, frames.length, radarFrameIndex, onRadarFrameChange]);

  const legend = useMemo(() => chemLegendRows(chemVariable), [chemVariable]);
  const aqi = aqiBand(chemPoint?.europeanAqi ?? Number.NaN);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[66] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/78 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[90vh] w-full max-w-[880px] flex-col overflow-hidden rounded-2xl">
        {/* header */}
        <header className="flex shrink-0 items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-400/15">
            <Radar size={13} className="text-cyan-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              全球雷达与大气化学
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {radar
                ? `${radar.source === 'librewxr' ? 'LibreWXR 镜像' : 'RainViewer'} · ${frames.length} 帧`
                : '等待雷达元数据'}
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

        {/* tabs */}
        <div className="flex shrink-0 items-center gap-1 border-b border-cyan-500/10 px-3 py-1.5">
          <TabButton active={tab === 'radar'} onClick={() => setTab('radar')} icon={Radar} label="降水雷达" />
          <TabButton active={tab === 'chem'} onClick={() => setTab('chem')} icon={Cloud} label="大气化学" />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {tab === 'radar' ? (
            <RadarPanel
              radar={radar}
              loading={radarLoading}
              error={radarError}
              frames={frames}
              frameIndex={radarFrameIndex}
              currentFrame={currentFrame}
              onFrameChange={onRadarFrameChange}
              playing={radarPlaying}
              onTogglePlay={onToggleRadarPlay}
              visible={radarVisible}
              onToggleVisible={onToggleRadarVisible}
              onRetry={onRetryRadar}
            />
          ) : (
            <ChemPanel
              variable={chemVariable}
              onVariableChange={onChemVariableChange}
              field={chemField}
              loading={chemLoading}
              error={chemError}
              visible={chemVisible}
              onToggleVisible={onToggleChemVisible}
              opacity={chemOpacity}
              onOpacityChange={onChemOpacityChange}
              onRetry={onRetryChem}
              legend={legend}
              point={chemPoint}
              pointLabel={pointLabel}
              aqi={aqi}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Radar tab                                                          */
/* ------------------------------------------------------------------ */

function RadarPanel({
  radar,
  loading,
  error,
  frames,
  frameIndex,
  currentFrame,
  onFrameChange,
  playing,
  onTogglePlay,
  visible,
  onToggleVisible,
  onRetry,
}: {
  radar: RadarMetadata | null;
  loading: boolean;
  error: string | null;
  frames: { time: number; path: string }[];
  frameIndex: number;
  currentFrame: { time: number; path: string } | undefined;
  onFrameChange: (i: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  visible: boolean;
  onToggleVisible: () => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex h-[280px] flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
        <p className="text-[11px] text-slate-400">正在获取雷达帧列表…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[280px] flex-col items-center justify-center gap-3 px-8 text-center">
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
    );
  }

  if (!radar || frames.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center">
        <p className="text-[11px] text-slate-500">暂无雷达数据</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* transport */}
      <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
        <button
          type="button"
          onClick={() => onFrameChange(0)}
          className="rounded p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-cyan-300"
          aria-label="第一帧"
        >
          <SkipBack size={12} />
        </button>

        <button
          type="button"
          onClick={onTogglePlay}
          className={[
            'flex h-7 w-7 items-center justify-center rounded-full transition-all',
            playing
              ? 'bg-cyan-400 text-slate-950 shadow-[0_0_14px_rgba(34,211,238,0.6)]'
              : 'bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25',
          ].join(' ')}
          aria-label={playing ? '暂停雷达动画' : '播放雷达动画'}
        >
          {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
        </button>

        <button
          type="button"
          onClick={() => onFrameChange(frames.length - 1)}
          className="rounded p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-cyan-300"
          aria-label="最后一帧"
        >
          <SkipForward size={12} />
        </button>

        <div className="hud-value min-w-0 flex-1 truncate text-[10px] text-cyan-100">
          {currentFrame ? formatRadarTime(currentFrame.time) : '—'}
          <span className="ml-1.5 text-[8.5px] text-slate-500">
            {frameIndex + 1} / {frames.length}
          </span>
        </div>

        <button
          type="button"
          onClick={onToggleVisible}
          className={[
            'rounded px-2 py-1 text-[9px] transition-colors',
            visible ? 'bg-cyan-400/18 text-cyan-200' : 'text-slate-500 hover:text-slate-300',
          ].join(' ')}
        >
          {visible ? '图层已开' : '图层已关'}
        </button>
      </div>

      {/* scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(0, frames.length - 1)}
        value={Math.min(frameIndex, Math.max(0, frames.length - 1))}
        onChange={(e) => onFrameChange(Number(e.target.value))}
        className="w-full"
        aria-label="雷达帧"
      />

      <div className="flex justify-between">
        <span className="hud-value text-[8px] text-slate-600">
          {frames[0] ? formatRadarTime(frames[0].time) : ''}
        </span>
        <span className="hud-value text-[8px] text-slate-600">
          {frames[frames.length - 1] ? formatRadarTime(frames[frames.length - 1].time) : ''}
        </span>
      </div>

      {/* maxzoom guard explanation */}
      <section className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
        <p className="mb-1 text-[9px] font-medium text-amber-200">缩放护栏已启用</p>
        <p className="text-[8.5px] leading-relaxed text-slate-500">
          图层已锁定 <span className="hud-value text-amber-300">maxzoom: 7</span>
          。RainViewer 在 7 级以上不返回 404，而是返回一张 200 状态的占位图（RGB、无 alpha，
          10 级以上为 512px），缺少这个约束会让地图在放大后变成灰块而不是报错。
          放大到 8–16 级时由 GPU 对 7 级瓦片做过采样插值，回波依然平滑。
        </p>
      </section>

      <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <p className="mb-1 text-[9px] text-slate-400">数据来源</p>
        <p className="text-[8.5px] leading-relaxed text-slate-500">
          {radar.source === 'librewxr' ? (
            <>
              主源 RainViewer 不可用，已自动故障转移至{' '}
              <span className="text-emerald-300">LibreWXR 开源兼容镜像</span>。
            </>
          ) : (
            <>
              RainViewer 主源正常。<span className="text-slate-600">主机 {radar.host}</span>
            </>
          )}
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chemistry tab                                                      */
/* ------------------------------------------------------------------ */

function ChemPanel({
  variable,
  onVariableChange,
  field,
  loading,
  error,
  visible,
  onToggleVisible,
  opacity,
  onOpacityChange,
  onRetry,
  legend,
  point,
  pointLabel,
  aqi,
}: {
  variable: ChemVariableId;
  onVariableChange: (v: ChemVariableId) => void;
  field: ChemField | null;
  loading: boolean;
  error: string | null;
  visible: boolean;
  onToggleVisible: () => void;
  opacity: number;
  onOpacityChange: (v: number) => void;
  onRetry: () => void;
  legend: { value: number; color: string }[];
  point: ChemPoint | null;
  pointLabel: string | null;
  aqi: { label: string; color: string };
}) {
  const meta = CHEM_VARIABLES.find((v) => v.id === variable);

  return (
    <div className="space-y-2">
      {/* variable picker */}
      <div className="flex flex-wrap items-center gap-1">
        {CHEM_VARIABLES.map((v) => {
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

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleVisible}
            className={[
              'rounded px-2 py-1 text-[9px] transition-colors',
              visible ? 'bg-cyan-400/18 text-cyan-200' : 'text-slate-500 hover:text-slate-300',
            ].join(' ')}
          >
            {visible ? '图层已开' : '图层已关'}
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={loading}
            className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9px] text-cyan-300 transition-colors hover:bg-cyan-500/10 disabled:opacity-40"
          >
            <RotateCw size={9} className={loading ? 'animate-aether-spin' : ''} />
            重取
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-[220px] flex-col items-center justify-center gap-3">
          <Loader2 size={20} className="animate-aether-spin text-cyan-400" />
          <p className="text-[11px] text-slate-400">正在拉取 CAMS 全球化学场…</p>
        </div>
      ) : error ? (
        <div className="flex h-[220px] flex-col items-center justify-center gap-3 px-8 text-center">
          <AlertTriangle size={18} className="text-amber-400" />
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
        <>
          {/* legend */}
          <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="hud-label">{meta?.label}</p>
              <span className="hud-value text-[8.5px] text-cyan-400/80">
                {meta?.unit || '无量纲'}
              </span>
            </div>

            <div className="flex h-3 w-full overflow-hidden rounded">
              {legend.map((row, i) => (
                <div
                  key={i}
                  className="flex-1"
                  style={{ background: row.color }}
                  title={`${row.value}`}
                />
              ))}
            </div>

            <div className="mt-1 flex justify-between">
              {legend.map((row, i) => (
                <span key={i} className="hud-value text-[7.5px] text-slate-600">
                  {row.value}
                </span>
              ))}
            </div>

            {field ? (
              <p className="mt-1.5 text-[8px] text-slate-500">
                当前范围{' '}
                <span className="hud-value text-slate-300">
                  {field.min.toFixed(1)} … {field.max.toFixed(1)}
                </span>
                ，格点 {field.grid.cols}×{field.grid.rows}
              </p>
            ) : null}

            <label className="mt-2 block">
              <span className="flex items-center justify-between">
                <span className="hud-label">图层不透明度</span>
                <span className="hud-value text-[9px] text-cyan-300">
                  {Math.round(opacity * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(opacity * 100)}
                onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
                className="mt-1 w-full"
              />
            </label>
          </section>

          {/* point diagnostic */}
          <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="hud-label">站点诊断</p>
              <span className="hud-value text-[8.5px] text-slate-500">
                {pointLabel ?? '未选点'}
              </span>
            </div>

            {point ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <Kv label="PM2.5" value={fmtUnit(point.pm25, 1, 'μg/m³')} color="#fbbf24" />
                <Kv label="沙尘" value={fmtUnit(point.dust, 1, 'μg/m³')} color="#d4a373" />
                <Kv label="气溶胶 AOD" value={fmtUnit(point.aod, 2, '')} color="#cbd5e1" />
                <Kv label="UV 指数" value={fmtUnit(point.uv, 1, '')} color="#a78bfa" />
                <Kv
                  label="欧洲 AQI"
                  value={fmtUnit(point.europeanAqi, 0, '')}
                  color={aqi.color}
                />
                <div className="flex items-baseline justify-between">
                  <span className="text-[8px] text-slate-500">等级</span>
                  <span
                    className="rounded px-1.5 py-px text-[8.5px] font-medium"
                    style={{ background: `${aqi.color}22`, color: aqi.color }}
                  >
                    {aqi.label}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-[8.5px] text-slate-500">
                切换到探针模式并在地球上悬停，即可读取该点的空气质量。
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Radar;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-1 rounded-md px-2.5 py-1 text-[10px] transition-colors',
        active
          ? 'bg-cyan-400/18 text-cyan-200'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      ].join(' ')}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

function Kv({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[8px] text-slate-500">{label}</span>
      <span className="hud-value text-[9.5px]" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function fmtUnit(v: number, digits: number, unit: string): string {
  if (!Number.isFinite(v)) return '—';
  return unit ? `${v.toFixed(digits)} ${unit}` : v.toFixed(digits);
}

function formatRadarTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}
