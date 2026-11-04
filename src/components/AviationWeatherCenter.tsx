/**
 * AviationWeatherCenter — the L4 panel.
 *
 * Three products behind one surface:
 *   1. SIGMET hazard list with vertical extent (base → top).
 *   2. Airport flight-category list and the runway crosswind calculator.
 *   3. Live flight counts from OpenSky.
 *
 * The crosswind instrument is the interactive centrepiece: it draws a runway
 * compass with the wind vector and reports the two components that actually
 * limit operations.
 */

import { useMemo, useState } from 'react';
import {
  X,
  Loader2,
  AlertTriangle,
  RotateCw,
  Plane,
  Wind,
  CloudLightning,
  Snowflake,
  Mountain,
  CircleDot,
  RefreshCw,
} from 'lucide-react';
import type {
  AirportObservation,
  FlightCollection,
  HazardCollection,
  HazardCode,
  PirepReport,
} from '../data/stage4';
import {
  CARDINAL_RUNWAYS,
  FLIGHT_CATEGORY_STYLES,
  HAZARD_STYLES,
  computeCrosswind,
  type FlightCategory,
} from '../data/stage4';

export interface AviationWeatherCenterProps {
  open: boolean;
  onClose: () => void;

  hazards: HazardCollection | null;
  hazardsLoading: boolean;
  hazardsError: string | null;
  hazardsVisible: boolean;
  onToggleHazards: () => void;
  onRetryHazards: () => void;

  airports: AirportObservation[];
  airportsLoading: boolean;
  airportsError: string | null;
  airportsVisible: boolean;
  onToggleAirports: () => void;
  onRetryAirports: () => void;

  pireps: PirepReport[];
  flights: FlightCollection | null;
  flightsVisible: boolean;
  onToggleFlights: () => void;
  onRetryFlights: () => void;
  flightsLoading: boolean;
}

const HAZARD_ICONS: Record<string, typeof Wind> = {
  TS: CloudLightning,
  TURB: Wind,
  ICE: Snowflake,
  VA: Mountain,
  TC: CircleDot,
  MTW: Mountain,
};

export function AviationWeatherCenter(props: AviationWeatherCenterProps) {
  const {
    open,
    onClose,
    hazards,
    hazardsLoading,
    hazardsError,
    hazardsVisible,
    onToggleHazards,
    onRetryHazards,
    airports,
    airportsLoading,
    airportsError,
    airportsVisible,
    onToggleAirports,
    onRetryAirports,
    pireps,
    flights,
    flightsVisible,
    onToggleFlights,
    onRetryFlights,
    flightsLoading,
  } = props;

  const [tab, setTab] = useState<'hazard' | 'airport' | 'flight'>('hazard');
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null);

  // Switching to the flight tab is the explicit user intent to spend an OpenSky
  // request; load (or reload) then rather than on panel open.
  const switchTab = (next: 'hazard' | 'airport' | 'flight') => {
    setTab(next);
    if (next === 'flight') props.onRetryFlights();
  };

  const selected = useMemo(
    () => airports.find((a) => a.icao === selectedIcao) ?? null,
    [airports, selectedIcao],
  );

  const runwayOptions = useMemo(() => {
    // Offer a generic compass plus any runway headings we can infer from the raw
    // METAR. AWC does not expose a runway database, so cardinals are the honest
    // fallback rather than pretending to know the real pavement layout.
    return CARDINAL_RUNWAYS;
  }, []);

  const [runwayHeading, setRunwayHeading] = useState(90);

  const crosswind = useMemo(() => {
    if (!selected) return null;
    return computeCrosswind(
      selected.windDir ?? Number.NaN,
      selected.windSpeedKt ?? Number.NaN,
      runwayHeading,
      selected.gustKt,
    );
  }, [selected, runwayHeading]);

  const categoryCounts = useMemo(() => {
    const counts: Record<FlightCategory, number> = { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 };
    for (const a of airports) counts[a.category] += 1;
    return counts;
  }, [airports]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="hud-panel relative flex max-h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-cyan-500/15 px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-400/15">
            <Plane size={13} className="text-amber-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-cyan-100">
              航空气象管制中心
            </h2>
            <p className="truncate text-[9px] uppercase tracking-[0.14em] text-slate-500">
              SIGMET {hazards?.hazards.length ?? 0} · METAR {airports.length} · PIREP{' '}
              {pireps.length}
              {flights ? ` · 航班 ${flights.flights.length}` : ''}
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

        <div className="flex shrink-0 items-center gap-1 border-b border-cyan-500/10 px-3 py-1.5">
          <Tab active={tab === 'hazard'} onClick={() => switchTab('hazard')} icon={AlertTriangle} label="危险天气" />
          <Tab active={tab === 'airport'} onClick={() => switchTab('airport')} icon={Plane} label="机场与侧风" />
          <Tab active={tab === 'flight'} onClick={() => switchTab('flight')} icon={Wind} label="实时航班" />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {tab === 'hazard' ? (
            <HazardTab
              hazards={hazards}
              loading={hazardsLoading}
              error={hazardsError}
              visible={hazardsVisible}
              onToggle={onToggleHazards}
              onRetry={onRetryHazards}
              pireps={pireps}
            />
          ) : tab === 'airport' ? (
            <AirportTab
              airports={airports}
              loading={airportsLoading}
              error={airportsError}
              visible={airportsVisible}
              onToggle={onToggleAirports}
              onRetry={onRetryAirports}
              categoryCounts={categoryCounts}
              selected={selected}
              onSelect={setSelectedIcao}
              runwayHeading={runwayHeading}
              onRunwayChange={setRunwayHeading}
              runwayOptions={runwayOptions}
              crosswind={crosswind}
            />
          ) : (
            <FlightTab
              flights={flights}
              loading={flightsLoading}
              visible={flightsVisible}
              onToggle={onToggleFlights}
              onRetry={onRetryFlights}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hazard tab                                                          */
/* ------------------------------------------------------------------ */

function HazardTab({
  hazards,
  loading,
  error,
  visible,
  onToggle,
  onRetry,
  pireps,
}: {
  hazards: HazardCollection | null;
  loading: boolean;
  error: string | null;
  visible: boolean;
  onToggle: () => void;
  onRetry: () => void;
  pireps: PirepReport[];
}) {
  const [filter, setFilter] = useState<HazardCode | 'ALL'>('ALL');

  const list = useMemo(() => {
    if (!hazards) return [];
    const all = filter === 'ALL' ? hazards.hazards : hazards.hazards.filter((h) => h.hazard === filter);
    return all.slice(0, 80);
  }, [hazards, filter]);

  if (loading) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
        <p className="text-[11px] text-slate-400">正在经代理获取全球 SIGMET…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center gap-3 px-8 text-center">
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

  return (
    <div className="space-y-2">
      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setFilter('ALL')}
          className={[
            'rounded px-2 py-1 text-[9.5px] transition-colors',
            filter === 'ALL' ? 'bg-cyan-400/18 text-cyan-200' : 'text-slate-500 hover:text-slate-300',
          ].join(' ')}
        >
          全部 {hazards?.hazards.length ?? 0}
        </button>

        {Object.entries(hazards?.counts ?? {}).map(([code, count]) => {
          const style = HAZARD_STYLES[code as HazardCode];
          if (!style) return null;
          const active = filter === code;
          return (
            <button
              key={code}
              type="button"
              onClick={() => setFilter(code as HazardCode)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[9px] transition-colors"
              style={{
                background: active ? `${style.color}22` : 'transparent',
                color: active ? style.color : '#64748b',
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.color }} />
              {style.label} {count}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggle}
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
            className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9px] text-cyan-300 transition-colors hover:bg-cyan-500/10"
          >
            <RotateCw size={9} />
            重取
          </button>
        </div>
      </div>

      {/* hazard list */}
      <div className="max-h-[300px] space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1.5">
        {list.map((h) => {
          const style = HAZARD_STYLES[h.hazard];
          const Icon = HAZARD_ICONS[h.hazard] ?? Wind;

          return (
            <div
              key={h.id}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/[0.04]"
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                style={{ background: `${style.color}22`, color: style.color }}
              >
                <Icon size={9} />
              </span>
              <span className="w-[62px] shrink-0 truncate text-[8.5px] text-slate-500">
                {h.firName.split(' ')[0]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[9.5px]" style={{ color: style.color }}>
                {h.qualifier || style.label}
              </span>
              <span className="hud-value shrink-0 text-[8.5px] text-slate-500">
                FL{(h.base / 100).toFixed(0)}–FL{(h.top / 100).toFixed(0)}
              </span>
            </div>
          );
        })}
        {list.length === 0 ? (
          <p className="px-2 py-4 text-center text-[9.5px] text-slate-500">该类别当前无生效报文</p>
        ) : null}
      </div>

      {/* vertical extent note */}
      <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <p className="mb-1 text-[9px] text-slate-400">关于三维高度</p>
        <p className="text-[8.5px] leading-relaxed text-slate-500">
          SIGMET 报文含 <span className="hud-value text-slate-300">base</span> 与{' '}
          <span className="hud-value text-slate-300">top</span> 两个飞行高度层（上表按 FL
          显示）。地图上以带色虚线多边形平铺渲染——真正的垂直拉伸在球面投影下会变成悬浮的竖直薄片，
          反而破坏地理可读性。高度信息在此处数值化呈现。
        </p>
      </section>

      {/* PIREP summary */}
      <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <div className="mb-1 flex items-baseline justify-between">
          <p className="hud-label">颠簸 / 积冰报告 PIREP</p>
          <span className="hud-value text-[8.5px] text-slate-500">{pireps.length} 条</span>
        </div>
        <div className="flex gap-3 text-[9px]">
          <span className="text-amber-300">
            颠簸 {pireps.filter((p) => p.turbulence).length}
          </span>
          <span className="text-cyan-300">
            积冰 {pireps.filter((p) => p.icing).length}
          </span>
          <span className="text-slate-500">
            其他 {pireps.filter((p) => !p.turbulence && !p.icing).length}
          </span>
        </div>
        <p className="mt-1 text-[8px] text-slate-600">
          颠簸/积冰由报文正文（TB / CHOP / IC）识别——AWC 不提供结构化强度字段。
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Airport tab                                                        */
/* ------------------------------------------------------------------ */

function AirportTab({
  airports,
  loading,
  error,
  visible,
  onToggle,
  onRetry,
  categoryCounts,
  selected,
  onSelect,
  runwayHeading,
  onRunwayChange,
  runwayOptions,
  crosswind,
}: {
  airports: AirportObservation[];
  loading: boolean;
  error: string | null;
  visible: boolean;
  onToggle: () => void;
  onRetry: () => void;
  categoryCounts: Record<FlightCategory, number>;
  selected: AirportObservation | null;
  onSelect: (icao: string | null) => void;
  runwayHeading: number;
  onRunwayChange: (h: number) => void;
  runwayOptions: number[];
  crosswind: ReturnType<typeof computeCrosswind> | null;
}) {
  if (loading) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="animate-aether-spin text-cyan-400" />
        <p className="text-[11px] text-slate-400">正在获取视口内 METAR…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center gap-3 px-8 text-center">
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

  return (
    <div className="grid gap-2 lg:grid-cols-[1fr_340px]">
      {/* airport list */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {(['VFR', 'MVFR', 'IFR', 'LIFR'] as FlightCategory[]).map((cat) => {
            const style = FLIGHT_CATEGORY_STYLES[cat];
            return (
              <span key={cat} className="flex items-center gap-1 text-[8.5px] text-slate-400">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.color }} />
                {cat} {categoryCounts[cat]}
              </span>
            );
          })}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggle}
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
              className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9px] text-cyan-300 hover:bg-cyan-500/10"
            >
              <RotateCw size={9} />
              重取
            </button>
          </div>
        </div>

        <div className="max-h-[340px] overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1">
          {airports.slice(0, 200).map((a) => {
            const style = FLIGHT_CATEGORY_STYLES[a.category];
            const isSel = selected?.icao === a.icao;
            return (
              <button
                key={a.icao}
                type="button"
                onClick={() => onSelect(isSel ? null : a.icao)}
                className={[
                  'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors',
                  isSel ? 'bg-cyan-400/12' : 'hover:bg-white/[0.04]',
                ].join(' ')}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: style.color }}
                />
                <span className="hud-value w-[46px] shrink-0 text-[9px] text-slate-300">
                  {a.icao}
                </span>
                <span className="min-w-0 flex-1 truncate text-[8.5px] text-slate-500">
                  {a.site.split(',')[0]}
                </span>
                <span className="hud-value shrink-0 text-[8.5px]" style={{ color: style.color }}>
                  {a.category}
                </span>
                <span className="hud-value shrink-0 text-[8px] text-slate-600">
                  {a.windDir ?? '—'}/{a.windSpeedKt ?? '—'}
                  {a.gustKt ? `G${a.gustKt}` : ''}
                </span>
              </button>
            );
          })}
          {airports.length === 0 ? (
            <p className="px-2 py-6 text-center text-[9.5px] text-slate-500">
              当前视口内无机场报文——请移动地图到机场密集区域。
            </p>
          ) : null}
        </div>
      </div>

      {/* crosswind instrument */}
      <div className="space-y-2">
        {selected && crosswind ? (
          <>
            <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <div className="mb-1.5 flex items-baseline justify-between">
                <p className="hud-value text-[12px] font-semibold text-cyan-200">
                  {selected.icao}
                </p>
                <span className="truncate text-[8.5px] text-slate-500">{selected.site}</span>
              </div>

              <RunwayCompass
                runwayHeading={runwayHeading}
                windDir={selected.windDir}
                windSpeed={selected.windSpeedKt}
                crosswind={crosswind.crosswind}
              />

              <label className="mt-2 block">
                <span className="flex items-center justify-between">
                  <span className="hud-label">跑道航向</span>
                  <span className="hud-value text-[9.5px] text-cyan-300">
                    {String(runwayHeading).padStart(3, '0')}°
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={350}
                  step={10}
                  value={runwayHeading}
                  onChange={(e) => onRunwayChange(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <div className="mt-1 flex flex-wrap gap-1">
                {runwayOptions.filter((r) => r % 90 === 0).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => onRunwayChange(r)}
                    className={[
                      'rounded px-1.5 py-0.5 text-[8.5px] font-mono transition-colors',
                      runwayHeading === r
                        ? 'bg-cyan-400/20 text-cyan-200'
                        : 'text-slate-500 hover:text-slate-300',
                    ].join(' ')}
                  >
                    {String(r).padStart(3, '0')}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
              <p className="hud-label mb-1.5">侧风分量解算</p>

              <div className="space-y-1">
                <Component
                  label="正侧风"
                  value={crosswind.crosswind}
                  unit="kt"
                  threshold={25}
                />
                <Component
                  label="顺/逆风"
                  value={crosswind.headwind}
                  unit="kt"
                  signed
                  threshold={-10}
                />
                {crosswind.gustCrosswind !== null ? (
                  <Component
                    label="阵风侧风"
                    value={crosswind.gustCrosswind}
                    unit="kt"
                    threshold={25}
                  />
                ) : null}
              </div>

              <div
                className="mt-1.5 flex items-center gap-1.5 rounded px-1.5 py-1"
                style={{
                  background:
                    crosswind.severity === 'danger'
                      ? 'rgba(220,38,38,0.18)'
                      : crosswind.severity === 'warning'
                        ? 'rgba(249,115,22,0.16)'
                        : crosswind.severity === 'caution'
                          ? 'rgba(250,204,21,0.14)'
                          : 'rgba(52,211,153,0.12)',
                }}
              >
                <span
                  className="text-[9px] font-medium"
                  style={{
                    color:
                      crosswind.severity === 'danger'
                        ? '#fca5a5'
                        : crosswind.severity === 'warning'
                          ? '#fdba74'
                          : crosswind.severity === 'caution'
                            ? '#fde047'
                            : '#6ee7b7',
                  }}
                >
                  {crosswind.note}
                </span>
              </div>

              <p className="mt-1.5 text-[8px] text-slate-600">
                V_cross = |V·sin(Δθ)|，V_head = V·cos(Δθ)，Δθ = 风向 − 跑道航向
              </p>
            </section>

            <section className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <p className="hud-label mb-1">原始 METAR</p>
              <p className="hud-value break-all text-[8px] leading-relaxed text-slate-400">
                {selected.raw}
              </p>
              <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[8px]">
                <Kv label="能见度" value={selected.visibility ?? '—'} />
                <Kv
                  label="云底"
                  value={selected.ceilingFt !== null ? `${selected.ceilingFt} ft` : '无显著'}
                />
                <Kv
                  label="温度/露点"
                  value={`${selected.temperature ?? '—'}/${selected.dewPoint ?? '—'}°C`}
                />
                <Kv
                  label="修正海压"
                  value={selected.altimeter !== null ? `${selected.altimeter} hPa` : '—'}
                />
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
            <p className="text-[9px] text-slate-500">
              在左侧选择一个机场，即可解算该处跑道侧风并查看解码后的 METAR。
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Runway compass: runway centreline, wind vector, and the crosswind component. */
function RunwayCompass({
  runwayHeading,
  windDir,
  windSpeed,
  crosswind,
}: {
  runwayHeading: number;
  windDir: number | null;
  windSpeed: number | null;
  crosswind: number;
}) {
  const size = 168;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 16;

  const toRad = Math.PI / 180;

  // Runway centreline, drawn as a long line through the centre.
  const rwyRad = (runwayHeading - 90) * toRad;
  const rwyX1 = cx + Math.cos(rwyRad) * radius;
  const rwyY1 = cy + Math.sin(rwyRad) * radius;
  const rwyX2 = cx - Math.cos(rwyRad) * radius;
  const rwyY2 = cy - Math.sin(rwyRad) * radius;

  // Wind vector points toward where the wind blows TO.
  const hasWind = typeof windDir === 'number' && windDir >= 0 && typeof windSpeed === 'number';
  const windToDir = hasWind ? (windDir as number) + 180 : 0;
  const windRad = (windToDir - 90) * toRad;
  const windLen = hasWind ? Math.min(radius, 22 + (windSpeed as number) * 2.2) : 0;
  const windX = cx + Math.cos(windRad) * windLen;
  const windY = cy + Math.sin(windRad) * windLen;

  const crossSeverity = crosswind > 35 ? '#f87171' : crosswind > 25 ? '#fb923c' : '#34d399';

  return (
    <svg width={size} height={size} className="mx-auto block">
      {/* compass ring */}
      <circle cx={cx} cy={cy} r={radius} fill="rgba(4,10,20,0.6)" stroke="rgba(34,211,238,0.2)" strokeWidth={1} />

      {/* cardinal ticks */}
      {[0, 90, 180, 270].map((deg) => {
        const rad = (deg - 90) * toRad;
        const x1 = cx + Math.cos(rad) * (radius - 5);
        const y1 = cy + Math.sin(rad) * (radius - 5);
        const x2 = cx + Math.cos(rad) * radius;
        const y2 = cy + Math.sin(rad) * radius;
        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(148,163,184,0.5)" strokeWidth={1} />;
      })}

      {/* runway centreline */}
      <line x1={rwyX1} y1={rwyY1} x2={rwyX2} y2={rwyY2} stroke="#e2e8f0" strokeWidth={4} strokeLinecap="round" />
      <line x1={rwyX1} y1={rwyY1} x2={rwyX2} y2={rwyY2} stroke="#4ade80" strokeWidth={1.4} strokeDasharray="4 5" />

      {/* wind vector */}
      {hasWind ? (
        <>
          <line
            x1={cx}
            y1={cy}
            x2={windX}
            y2={windY}
            stroke={crossSeverity}
            strokeWidth={2}
            markerEnd="url(#windArrow)"
          />
          <circle cx={windX} cy={windY} r={3} fill={crossSeverity} />
        </>
      ) : null}

      <defs>
        <marker id="windArrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={crossSeverity} />
        </marker>
      </defs>

      {/* labels */}
      <text x={cx} y={14} textAnchor="middle" fontSize={8} fill="rgba(148,163,184,0.7)">
        N
      </text>
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize={9} fill="#22d3ee" fontFamily="ui-monospace">
        {String(runwayHeading).padStart(3, '0')}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={7.5} fill="rgba(148,163,184,0.6)">
        {hasWind ? `${windDir}° / ${windSpeed}kt` : '静风'}
      </text>
    </svg>
  );
}

function Component({
  label,
  value,
  unit,
  signed,
  threshold,
}: {
  label: string;
  value: number;
  unit: string;
  signed?: boolean;
  threshold: number;
}) {
  const over = signed ? value < threshold : value > threshold * 0.6;
  const color = over ? '#f87171' : signed && value < 0 ? '#fbbf24' : '#e2e8f0';

  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[9px] text-slate-500">{label}</span>
      <span className="hud-value text-[13px] font-medium" style={{ color }}>
        {Number.isFinite(value)
          ? `${signed && value > 0 ? '+' : ''}${value.toFixed(1)}`
          : '—'}
        <span className="ml-0.5 text-[8.5px] font-normal text-slate-500">{unit}</span>
      </span>
    </div>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-slate-600">{label}</span>
      <span className="hud-value text-slate-400">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Flight tab                                                         */
/* ------------------------------------------------------------------ */

function FlightTab({
  flights,
  loading,
  visible,
  onToggle,
  onRetry,
}: {
  flights: FlightCollection | null;
  loading: boolean;
  visible: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const active = flights?.flights.filter((f) => !f.onGround) ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-slate-400">
          视口内航班 <span className="hud-value text-cyan-300">{flights?.flights.length ?? 0}</span>
          （空中 {active.length}）
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggle}
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
            className="flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[9px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
          >
            <RefreshCw size={9} className={loading ? 'animate-aether-spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1">
        {active.slice(0, 120).map((f) => (
          <div key={f.icao24} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/[0.04]">
            <span className="hud-value w-[62px] shrink-0 truncate text-[9px] text-cyan-300">
              {f.callsign || f.icao24}
            </span>
            <span className="min-w-0 flex-1 truncate text-[8.5px] text-slate-500">{f.country}</span>
            <span className="hud-value shrink-0 text-[8.5px] text-slate-400">
              {f.altitudeM !== null ? `${(f.altitudeM * 3.28084 / 1000).toFixed(0)}kft` : '—'}
            </span>
            <span className="hud-value w-[42px] shrink-0 text-right text-[8.5px] text-indigo-300">
              {f.heading !== null ? `${f.heading.toFixed(0)}°` : '—'}
            </span>
          </div>
        ))}
        {active.length === 0 ? (
          <p className="px-2 py-6 text-center text-[9.5px] text-slate-500">
            {loading ? '正在连接 OpenSky…' : '当前视口内无空中航班'}
          </p>
        ) : null}
      </div>

      <section className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
        <p className="text-[8.5px] leading-relaxed text-slate-500">
          OpenSky 匿名访问可用但限流（约 15 分钟 100 次），因此不会自动轮询——
          点「刷新」手动更新。高度为气压高度，已换算为千英尺显示。
        </p>
      </section>
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Plane;
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
