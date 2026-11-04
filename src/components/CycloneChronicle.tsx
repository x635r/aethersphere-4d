/**
 * CycloneChronicle — the storm museum and "superstorm arena".
 *
 * Left: the eight legendary storms with their real IBTrACS intensity records.
 * Right: either a single-storm detail card (with the time slider driving the
 * map vortex) or the comparison view that overlays every selected storm at a
 * common reference point.
 *
 * Every number shown comes from the bundled archive; nothing is recomputed into
 * a different unit without saying so, and storms missing wind radii say so
 * explicitly instead of drawing a plausible-looking ring.
 */

import { useMemo, useRef, useState } from 'react';
import { X, Upload, Activity, MapPin, Info } from 'lucide-react';
import type { CycloneRecord, CycloneSpec } from '../utils/cyclone';
import {
  basinLabel,
  buildCycloneSpec,
  sortByMetric,
  saffirSimpson,
  type ComparisonMetric,
} from '../utils/cyclone';

export interface CycloneChronicleProps {
  open: boolean;
  onClose: () => void;
  records: CycloneRecord[];
  /** Currently focused storm id, or null. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Index into the selected storm's track. */
  timeIndex: number;
  onTimeIndexChange: (i: number) => void;
  visible: boolean;
  onToggleVisible: () => void;
  showRings: boolean;
  onToggleRings: () => void;
  /** Comparison membership. */
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  comparisonMetric: ComparisonMetric;
  onComparisonMetric: (m: ComparisonMetric) => void;
  /** Reference point for the arena overlay. */
  arenaPoint: { lat: number; lng: number } | null;
  onSetArenaPoint: (p: { lat: number; lng: number } | null) => void;
  /** Asks the map for the current probe location. */
  probePoint: { lat: number; lng: number } | null;
  /** Accepts a dropped/selected IBTrACS file. */
  onImportFile: (file: File) => void;
  importWarnings: string[];
  importError: string | null;
}

export function CycloneChronicle(props: CycloneChronicleProps) {
  const {
    open,
    onClose,
    records,
    selectedId,
    onSelect,
    timeIndex,
    onTimeIndexChange,
    visible,
    onToggleVisible,
    showRings,
    onToggleRings,
    compareIds,
    onToggleCompare,
    comparisonMetric,
    onComparisonMetric,
    arenaPoint,
    onSetArenaPoint,
    probePoint,
    onImportFile,
    importWarnings,
    importError,
  } = props;

  const [tab, setTab] = useState<'museum' | 'arena'>('museum');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Build specs once per record set so ACE/travel aren't recomputed per render. */
  const specs = useMemo(() => records.map(buildCycloneSpec), [records]);

  const selectedSpec = useMemo(
    () => specs.find((s) => s.record.id === selectedId) ?? null,
    [specs, selectedId],
  );

  const compareSpecs = useMemo(
    () => sortByMetric(specs.filter((s) => compareIds.includes(s.record.id)), comparisonMetric),
    [specs, compareIds, comparisonMetric],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/82 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[93vh] w-full max-w-[1160px] flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-fuchsia-400/15">
            <Activity size={13} className="text-fuchsia-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              超级台风数字博物馆
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              NOAA IBTrACS v04r01 · {records.length} 个传奇风暴 · 真实最佳路径
            </p>
          </div>

          <div className="ml-3 flex items-center gap-1">
            <TabButton active={tab === 'museum'} onClick={() => setTab('museum')} label="博物馆" />
            <TabButton active={tab === 'arena'} onClick={() => setTab('arena')} label={`风王竞技场 ${compareIds.length}`} />
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleVisible}
              className={[
                'rounded px-2 py-1 text-[9px] transition-colors',
                visible ? 'bg-fuchsia-400/18 text-fuchsia-200' : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {visible ? '图层已开' : '图层已关'}
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
          {tab === 'museum' ? (
            <div className="grid gap-2 lg:grid-cols-[300px_1fr]">
              {/* storm list */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="hud-label">传奇风暴</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 rounded border border-cyan-500/25 px-1.5 py-0.5 text-[8.5px] text-cyan-300 hover:bg-cyan-500/10"
                  >
                    <Upload size={8} />
                    导入 IBTrACS
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".geojson,.json,application/geo+json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onImportFile(file);
                      e.target.value = '';
                    }}
                  />
                </div>

                <div className="max-h-[380px] space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1">
                  {records.map((r) => {
                    const isSel = selectedId === r.id;
                    const cat = saffirSimpson(r.peakWindKt);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onSelect(isSel ? null : r.id)}
                        className={[
                          'flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left transition-colors',
                          isSel ? 'bg-fuchsia-400/12' : 'hover:bg-white/[0.04]',
                        ].join(' ')}
                      >
                        <span
                          className="h-6 w-1 shrink-0 rounded-full"
                          style={{ background: cat.color }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] text-slate-200">
                            {r.year} {r.nameZh}
                            <span className="ml-1 text-[8px] text-slate-600">{r.nameEn.replace(/^(Super )?(Typhoon|Hurricane) /, '')}</span>
                          </span>
                          <span className="block truncate text-[8px] text-slate-600">
                            {basinLabel(r.basin)} · {r.peakWindKt}kt / {r.minPressureHpa}hPa
                          </span>
                        </span>
                        <span
                          className="hud-value shrink-0 text-[8px]"
                          style={{ color: cat.color }}
                        >
                          {cat.category > 0 ? `C${cat.category}` : cat.label.split(' ')[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {importError ? (
                  <p className="rounded bg-rose-500/10 px-2 py-1 text-[8.5px] text-rose-300">
                    {importError}
                  </p>
                ) : null}
                {importWarnings.length > 0 ? (
                  <div className="rounded bg-amber-500/10 px-2 py-1">
                    {importWarnings.map((w, i) => (
                      <p key={i} className="text-[8px] text-amber-300">
                        {w}
                      </p>
                    ))}
                  </div>
                ) : null}

                <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
                  <p className="mb-1 text-[8.5px] text-slate-500">数据来源</p>
                  <p className="text-[8px] leading-relaxed text-slate-600">
                    全部轨迹、风速、气压与风圈半径取自 NOAA IBTrACS v04r01
                    最佳路径档案，按 6 小时时次原样呈现。Tip (1979) 与 Andrew (1992)
                    无风圈记录——散度计时代之前未常规归档，界面会明确标注而非补造。
                  </p>
                </section>
              </div>

              {/* detail */}
              <div className="space-y-2">
                {selectedSpec ? (
                  <StormDetail
                    spec={selectedSpec}
                    timeIndex={timeIndex}
                    onTimeIndexChange={onTimeIndexChange}
                    showRings={showRings}
                    onToggleRings={onToggleRings}
                    inCompare={compareIds.includes(selectedSpec.record.id)}
                    onToggleCompare={() => onToggleCompare(selectedSpec.record.id)}
                  />
                ) : (
                  <div className="flex h-[320px] flex-col items-center justify-center gap-2 rounded-lg border border-white/5 bg-white/[0.02]">
                    <MapPin size={18} className="text-slate-600" />
                    <p className="text-[10px] text-slate-500">
                      从左侧选择一个风暴，查看轨迹与强度时间序列
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ArenaView
              specs={compareSpecs}
              allSpecs={specs}
              metric={comparisonMetric}
              onMetric={onComparisonMetric}
              compareIds={compareIds}
              onToggleCompare={onToggleCompare}
              arenaPoint={arenaPoint}
              onSetArenaPoint={onSetArenaPoint}
              probePoint={probePoint}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Storm detail                                                       */
/* ------------------------------------------------------------------ */

function StormDetail({
  spec,
  timeIndex,
  onTimeIndexChange,
  showRings,
  onToggleRings,
  inCompare,
  onToggleCompare,
}: {
  spec: CycloneSpec;
  timeIndex: number;
  onTimeIndexChange: (i: number) => void;
  showRings: boolean;
  onToggleRings: () => void;
  inCompare: boolean;
  onToggleCompare: () => void;
}) {
  const { record, track } = spec;
  const idx = Math.max(0, Math.min(track.length - 1, timeIndex));
  const point = track[idx];

  // Header badge = the storm's peak category (this is a record-level summary).
  // The timeline readout below uses the per-fix category, which is why a
  // newly-formed storm can legitimately read "TD" there.
  const peakCat = saffirSimpson(record.peakWindKt);
  const cat = point ? saffirSimpson(point.windKt) : peakCat;

  return (
    <>
      {/* header card */}
      <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h3 className="text-[16px] font-semibold text-cyan-100">
                {record.year} {record.nameZh}
              </h3>
              <span className="truncate text-[9px] text-slate-500">{record.nameEn}</span>
              <span
                className="rounded px-1.5 py-px text-[8.5px] font-medium"
                style={{ background: `${peakCat.color}22`, color: peakCat.color }}
                title="该风暴生命史中的最强等级"
              >
                峰值 {peakCat.label}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-slate-400">{record.note}</p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={onToggleRings}
              className={[
                'rounded px-2 py-1 text-[8.5px] transition-colors',
                showRings ? 'bg-cyan-400/18 text-cyan-200' : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {showRings ? '风圈已开' : '风圈已关'}
            </button>
            <button
              type="button"
              onClick={onToggleCompare}
              className={[
                'rounded px-2 py-1 text-[8.5px] transition-colors',
                inCompare ? 'bg-fuchsia-400/20 text-fuchsia-200' : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {inCompare ? '移出对比' : '加入对比'}
            </button>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          <Stat label="峰值风速" value={`${record.peakWindKt.toFixed(0)}`} unit="kt" color="#f87171" />
          <Stat label="最低气压" value={`${record.minPressureHpa.toFixed(0)}`} unit="hPa" color="#60a5fa" />
          <Stat label="ACE 指数" value={spec.ace.toFixed(1)} unit="10⁴kt²" color="#fbbf24" />
          <Stat
            label="R34 直径"
            value={spec.r34DiameterKm ? spec.r34DiameterKm.toFixed(0) : '—'}
            unit={spec.r34DiameterKm ? 'km' : '无记录'}
            color="#22d3ee"
          />
          <Stat label="路径长度" value={spec.travelKm.toFixed(0)} unit="km" color="#a78bfa" />
        </div>

        {!record.hasWindRadii ? (
          <p className="mt-1.5 flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-1 text-[8px] text-amber-300">
            <Info size={8} />
            该风暴在 IBTrACS 中无风圈半径记录（早于散度计常规归档年代），因此不绘制 R34/R50/R64 环。
          </p>
        ) : null}
      </section>

      {/* time slider */}
      <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
        <div className="mb-1.5 flex items-baseline justify-between">
          <p className="hud-label">风暴时间轴</p>
          <span className="hud-value text-[9px] text-cyan-300">
            {point ? formatTime(point.time) : '—'} · 第 {idx + 1} / {track.length} 时次
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={Math.max(0, track.length - 1)}
          value={idx}
          onChange={(e) => onTimeIndexChange(Number(e.target.value))}
          className="w-full"
          aria-label="风暴时间"
        />

        <div className="mt-1 flex justify-between">
          <span className="hud-value text-[8px] text-slate-600">
            {track[0] ? formatTime(track[0].time) : ''}
          </span>
          <span className="hud-value text-[8px] text-slate-600">
            {track[track.length - 1] ? formatTime(track[track.length - 1].time) : ''}
          </span>
        </div>

        {point ? (
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-white/5 pt-1.5 text-[9px] sm:grid-cols-4">
            <Kv label="位置" value={`${point.lat.toFixed(1)}°, ${point.lng.toFixed(1)}°`} />
            <Kv
              label={`风速 · ${cat.label}`}
              value={fmt(point.windKt, 0, 'kt')}
              color={cat.color}
            />
            <Kv label="气压" value={fmt(point.pressureHpa, 0, 'hPa')} />
            <Kv
              label="R34"
              value={point.r34 ? `${point.r34.toFixed(0)} nm` : '无记录'}
            />
          </div>
        ) : null}
      </section>

      {/* intensity chart */}
      <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
        <p className="hud-label mb-1">强度与气压时间序列</p>
        <IntensityChart spec={spec} activeIndex={idx} />
      </section>
    </>
  );
}

/** Inline SVG chart of wind (line) and pressure (line) over the storm's life. */
function IntensityChart({ spec, activeIndex }: { spec: CycloneSpec; activeIndex: number }) {
  const { track } = spec;
  const width = 660;
  const height = 130;
  const pad = { top: 8, right: 34, bottom: 16, left: 30 };

  if (track.length < 2) {
    return <p className="py-6 text-center text-[9px] text-slate-600">轨迹点不足，无法绘制</p>;
  }

  const winds = track.map((p) => (Number.isFinite(p.windKt) ? p.windKt : 0));
  const pressures = track.map((p) => (Number.isFinite(p.pressureHpa) ? p.pressureHpa : Number.NaN));
  const validP = pressures.filter(Number.isFinite);

  const maxWind = Math.max(...winds, 1);
  const minP = validP.length > 0 ? Math.min(...validP) : 900;
  const maxP = validP.length > 0 ? Math.max(...validP) : 1010;

  const xAt = (i: number) => pad.left + (i / (track.length - 1)) * (width - pad.left - pad.right);
  const yWind = (w: number) => height - pad.bottom - (w / maxWind) * (height - pad.top - pad.bottom);
  const yPres = (p: number) =>
    pad.top + ((p - minP) / Math.max(1, maxP - minP)) * (height - pad.top - pad.bottom);

  const windPath = winds.map((w, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yWind(w).toFixed(1)}`).join(' ');

  let presPath = '';
  let started = false;
  pressures.forEach((p, i) => {
    if (!Number.isFinite(p)) {
      started = false;
      return;
    }
    presPath += `${started ? 'L' : 'M'}${xAt(i).toFixed(1)},${yPres(p).toFixed(1)} `;
    started = true;
  });

  // Category thresholds as horizontal guides.
  const guides = [64, 96, 137].filter((t) => t <= maxWind);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height: 'auto' }}>
      {guides.map((g) => (
        <line
          key={g}
          x1={pad.left}
          y1={yWind(g)}
          x2={width - pad.right}
          y2={yWind(g)}
          stroke="rgba(148,163,184,0.16)"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      ))}
      {guides.map((g) => (
        <text
          key={`l${g}`}
          x={pad.left - 3}
          y={yWind(g) + 3}
          textAnchor="end"
          fontSize={7}
          fill="rgba(148,163,184,0.55)"
        >
          {g}
        </text>
      ))}

      <path d={presPath} fill="none" stroke="#60a5fa" strokeWidth={1.2} strokeOpacity={0.75} />
      <path d={windPath} fill="none" stroke="#f87171" strokeWidth={1.8} />

      {/* active cursor */}
      <line
        x1={xAt(activeIndex)}
        y1={pad.top}
        x2={xAt(activeIndex)}
        y2={height - pad.bottom}
        stroke="rgba(255,255,255,0.5)"
        strokeDasharray="2 3"
        strokeWidth={1}
      />
      <circle cx={xAt(activeIndex)} cy={yWind(winds[activeIndex] ?? 0)} r={3} fill="#f87171" />

      <text x={pad.left} y={height - 4} fontSize={7} fill="rgba(148,163,184,0.55)">
        起始
      </text>
      <text x={width - pad.right} y={height - 4} fontSize={7} textAnchor="end" fill="rgba(148,163,184,0.55)">
        消散
      </text>
      <text x={width - pad.right + 4} y={pad.top + 6} fontSize={7} fill="#f87171">
        风 kt
      </text>
      <text x={width - pad.right + 4} y={pad.top + 18} fontSize={7} fill="#60a5fa">
        压 hPa
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Arena                                                              */
/* ------------------------------------------------------------------ */

function ArenaView({
  specs,
  allSpecs,
  metric,
  onMetric,
  compareIds,
  onToggleCompare,
  arenaPoint,
  onSetArenaPoint,
  probePoint,
}: {
  specs: CycloneSpec[];
  allSpecs: CycloneSpec[];
  metric: ComparisonMetric;
  onMetric: (m: ComparisonMetric) => void;
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  arenaPoint: { lat: number; lng: number } | null;
  onSetArenaPoint: (p: { lat: number; lng: number } | null) => void;
  probePoint: { lat: number; lng: number } | null;
}) {
  const metrics: { id: ComparisonMetric; label: string; unit: string }[] = [
    { id: 'wind', label: '峰值风速', unit: 'kt' },
    { id: 'pressure', label: '最低气压', unit: 'hPa' },
    { id: 'size', label: 'R34 风圈', unit: 'km' },
    { id: 'ace', label: 'ACE', unit: '10⁴kt²' },
    { id: 'travel', label: '路径长度', unit: 'km' },
  ];

  const activeMetric = metrics.find((m) => m.id === metric) ?? metrics[0];
  const maxValue = Math.max(
    1,
    ...specs.map((s) => valueOfMetric(s, metric)),
  );

  return (
    <div className="grid gap-2 lg:grid-cols-[1fr_300px]">
      <div className="space-y-2">
        {/* metric picker */}
        <div className="flex flex-wrap items-center gap-1">
          {metrics.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onMetric(m.id)}
              className={[
                'rounded px-2 py-1 text-[9.5px] transition-colors',
                metric === m.id
                  ? 'bg-fuchsia-400/18 text-fuchsia-200'
                  : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {m.label}
            </button>
          ))}
          <span className="ml-auto hud-value text-[8.5px] text-slate-500">
            单位 {activeMetric.unit}
          </span>
        </div>

        {/* comparison bars */}
        {specs.length === 0 ? (
          <div className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-lg border border-white/5 bg-white/[0.02]">
            <p className="text-[10px] text-slate-500">
              在博物馆标签页点「加入对比」选择 2–4 个风暴
            </p>
          </div>
        ) : (
          <div className="space-y-1.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
            {specs.map((s) => {
              const v = valueOfMetric(s, metric);
              const frac = maxValue > 0 ? v / maxValue : 0;
              const cat = saffirSimpson(s.record.peakWindKt);

              return (
                <div key={s.record.id} className="flex items-center gap-2">
                  <span className="w-[104px] shrink-0 truncate text-[9.5px] text-slate-300">
                    {s.record.year} {s.record.nameZh}
                  </span>
                  <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-slate-800/60">
                    <div
                      className="h-full rounded-sm transition-all"
                      style={{
                        width: `${(frac * 100).toFixed(1)}%`,
                        background: cat.color,
                        boxShadow: `0 0 10px ${cat.color}55`,
                      }}
                    />
                  </div>
                  <span className="hud-value w-[62px] shrink-0 text-right text-[9.5px]" style={{ color: cat.color }}>
                    {v > 0 ? v.toFixed(metric === 'ace' ? 1 : 0) : '—'}
                  </span>
                </div>
              );
            })}

            <p className="border-t border-white/5 pt-1.5 text-[8px] leading-relaxed text-slate-600">
              数值全部来自 IBTrACS 最佳路径。R34 风圈一项对无记录的早期风暴显示为
              「—」——它们的风圈确实未被归档，用 0 参与比较会造成误导。
            </p>
          </div>
        )}

        {/* pressure funnel comparison */}
        {specs.length > 0 ? <PressureFunnel specs={specs} /> : null}

        {/* arena reference point */}
        <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
          <div className="mb-1 flex items-baseline justify-between">
            <p className="hud-label">同屏基准点</p>
            {arenaPoint ? (
              <button
                type="button"
                onClick={() => onSetArenaPoint(null)}
                className="text-[8.5px] text-slate-500 hover:text-rose-300"
              >
                清除
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => probePoint && onSetArenaPoint(probePoint)}
              disabled={!probePoint}
              className="rounded border border-cyan-500/25 px-2 py-1 text-[8.5px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
            >
              {probePoint ? `用探针位置 ${probePoint.lat.toFixed(1)}°, ${probePoint.lng.toFixed(1)}°` : '探针未定位'}
            </button>
            <button
              type="button"
              onClick={() => onSetArenaPoint({ lat: 22.3, lng: 114.2 })}
              className="rounded border border-white/10 px-2 py-1 text-[8.5px] text-slate-400 hover:text-slate-200"
            >
              香港
            </button>
            <button
              type="button"
              onClick={() => onSetArenaPoint({ lat: 31.2, lng: 121.5 })}
              className="rounded border border-white/10 px-2 py-1 text-[8.5px] text-slate-400 hover:text-slate-200"
            >
              上海
            </button>
          </div>

          <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
            选择基准点后，各风暴巅峰时刻的 R34 风圈会平移投影到该点上叠加显示——这就是
            「把 1979 年泰培拖到你所在城市上空」的效果，直观对比环流覆盖范围。
          </p>
        </section>
      </div>

      {/* membership list */}
      <div className="space-y-1.5">
        <p className="hud-label">可选风暴</p>
        <div className="max-h-[420px] space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1">
          {allSpecs.map((s) => {
            const on = compareIds.includes(s.record.id);
            const cat = saffirSimpson(s.record.peakWindKt);
            return (
              <button
                key={s.record.id}
                type="button"
                onClick={() => onToggleCompare(s.record.id)}
                className={[
                  'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors',
                  on ? 'bg-fuchsia-400/12' : 'hover:bg-white/[0.04]',
                ].join(' ')}
              >
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[8px]"
                  style={{
                    borderColor: on ? cat.color : 'rgba(100,116,139,0.6)',
                    background: on ? `${cat.color}33` : 'transparent',
                    color: cat.color,
                  }}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate text-[9px] text-slate-300">
                  {s.record.year} {s.record.nameZh}
                </span>
                <span className="hud-value shrink-0 text-[8px] text-slate-500">
                  {s.record.peakWindKt}kt
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Depth profile of each storm's pressure well.
 *
 * Drawn as nested arcs from 1010 hPa down to each storm's minimum: the visual
 * equivalent of "how deep is the hole", which is what a pressure funnel shows.
 */
function PressureFunnel({ specs }: { specs: CycloneSpec[] }) {
  const width = 660;
  const height = 120;
  const pad = { left: 30, right: 12, top: 12, bottom: 20 };

  const deepest = Math.min(...specs.map((s) => s.record.minPressureHpa));
  const surface = 1010;

  const yAt = (p: number) =>
    pad.top + ((p - deepest) / Math.max(1, surface - deepest)) * (height - pad.top - pad.bottom);

  const slot = (width - pad.left - pad.right) / Math.max(1, specs.length);

  return (
    <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
      <p className="hud-label mb-1">气压漏斗深度剖面</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height: 'auto' }}>
        <line
          x1={pad.left}
          y1={yAt(surface)}
          x2={width - pad.right}
          y2={yAt(surface)}
          stroke="rgba(148,163,184,0.25)"
          strokeDasharray="3 3"
        />
        <text x={pad.left - 3} y={yAt(surface) + 3} textAnchor="end" fontSize={7} fill="rgba(148,163,184,0.6)">
          {surface}
        </text>

        {specs.map((s, i) => {
          const cx = pad.left + slot * (i + 0.5);
          const halfWidth = Math.min(34, slot * 0.34);
          const bottom = yAt(s.record.minPressureHpa);
          const cat = saffirSimpson(s.record.peakWindKt);

          // Funnel path: from the surface line down to the storm's minimum and
          // back up, mirrored around the centre.
          const d = `M${cx - halfWidth},${yAt(surface)} Q${cx - halfWidth * 0.2},${bottom} ${cx},${bottom} Q${cx + halfWidth * 0.2},${bottom} ${cx + halfWidth},${yAt(surface)}`;

          return (
            <g key={s.record.id}>
              <path d={d} fill={`${cat.color}22`} stroke={cat.color} strokeWidth={1.2} />
              <text x={cx} y={bottom + 9} textAnchor="middle" fontSize={7.5} fill={cat.color}>
                {s.record.minPressureHpa.toFixed(0)}
              </text>
              <text x={cx} y={height - 5} textAnchor="middle" fontSize={7} fill="rgba(148,163,184,0.65)">
                {s.record.year}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function valueOfMetric(spec: CycloneSpec, metric: ComparisonMetric): number {
  switch (metric) {
    case 'wind':
      return spec.record.peakWindKt;
    case 'pressure':
      // Higher bars should mean "stronger", so plot the depth below 1010 hPa.
      return Math.max(0, 1010 - spec.record.minPressureHpa);
    case 'size':
      return spec.r34DiameterKm ?? 0;
    case 'ace':
      return spec.ace;
    case 'travel':
      return spec.travelKm;
    default:
      return 0;
  }
}

function Stat({
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

function Kv({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-slate-600">{label}</span>
      <span className="hud-value" style={{ color: color ?? '#cbd5e1' }}>
        {value}
      </span>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md px-2.5 py-1 text-[10px] transition-colors',
        active
          ? 'bg-fuchsia-400/18 text-fuchsia-200'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function fmt(v: number, digits: number, unit: string): string {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} ${unit}`;
}

function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  const d = new Date(epochMs);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}Z`;
}
