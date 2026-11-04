/**
 * LayerMatrixDock — the left-hand vertical control dock.
 *
 * Six vertical "circles" (L1..L6) mirror the atmosphere from ocean to space.
 * Each group expands into its layer toggles; Stage 1 fully implements the L3
 * troposphere group (wind field, scalar overlays) and L6's terminator, while
 * the other groups expose what they will control so the map stays legible
 * about what is and is not live yet.
 */

import { useMemo, useState } from 'react';
import {
  Waves,
  Radar,
  Wind,
  Plane,
  Layers,
  Sparkles,
  ChevronDown,
  Eye,
  EyeOff,
  Droplets,
  Thermometer,
  CloudLightning,
  Gauge,
  CircleDot,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { MATRIX_GROUPS, SCALAR_FIELDS } from '../core/levels';
import { useAppStore } from '../state/store';

interface LayerRowProps {
  label: string;
  hint?: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  icon?: LucideIcon;
}

function LayerRow({ label, hint, active, onToggle, disabled, icon: Icon }: LayerRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={[
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-40'
          : active
            ? 'bg-cyan-500/15 text-cyan-200'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
          active
            ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-300'
            : 'border-slate-600/60 text-slate-500',
        ].join(' ')}
      >
        {Icon ? <Icon size={11} strokeWidth={2.2} /> : <CircleDot size={10} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium leading-tight">{label}</span>
        {hint ? (
          <span className="block truncate text-[9px] leading-tight text-slate-500">{hint}</span>
        ) : null}
      </span>

      {!disabled ? (
        active ? (
          <Eye size={11} className="shrink-0 text-cyan-400/80" />
        ) : (
          <EyeOff size={11} className="shrink-0 text-slate-600 group-hover:text-slate-400" />
        )
      ) : null}
    </button>
  );
}

/** A dock row that opens a Stage 3 panel rather than toggling a layer. */
function Stage3Row({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-cyan-500/40 text-cyan-400/80 transition-colors group-hover:border-cyan-400/70 group-hover:text-cyan-300">
        <ExternalLink size={9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium leading-tight">{label}</span>
        <span className="block truncate text-[9px] leading-tight text-slate-500">{hint}</span>
      </span>
    </button>
  );
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  L1: Waves,
  L2: Radar,
  L3: Wind,
  L4: Plane,
  L5: Layers,
  L6: Sparkles,
};

const SCALAR_ICONS: Record<string, LucideIcon> = {
  wind_speed: Gauge,
  temperature: Thermometer,
  geopotential_height: Layers,
  relative_humidity: Droplets,
  cloud_cover: CloudLightning,
  vertical_velocity: Wind,
};

export interface LayerMatrixDockProps {
  /** Open the Stage 3 panels. */
  onOpenArena?: () => void;
  onOpenRivers?: () => void;
  onOpenRadar?: () => void;
  onOpenSpaghetti?: () => void;
  onOpenAviation?: () => void;
  onOpenSpace?: () => void;
  onOpenCyclone?: () => void;
  onOpenClimate?: () => void;
  cycloneVisible?: boolean;
  onToggleCyclone?: () => void;
  hazardsVisible?: boolean;
  onToggleHazards?: () => void;
  airportsVisible?: boolean;
  onToggleAirports?: () => void;
  flightsVisible?: boolean;
  onToggleFlights?: () => void;
  auroraVisible?: boolean;
  onToggleAurora?: () => void;
  /** Availability flags, so dead entries can be disabled instead of lying. */
  radarAvailable?: boolean;
  ivtAvailable?: boolean;
  ivtVisible?: boolean;
  onToggleIvt?: () => void;
  chemVisible?: boolean;
  onToggleChem?: () => void;
}

export function LayerMatrixDock({
  onOpenArena,
  onOpenRivers,
  onOpenRadar,
  onOpenSpaghetti,
  onOpenAviation,
  onOpenSpace,
  onOpenCyclone,
  onOpenClimate,
  cycloneVisible = false,
  onToggleCyclone,
  hazardsVisible = false,
  onToggleHazards,
  airportsVisible = false,
  onToggleAirports,
  flightsVisible = false,
  onToggleFlights,
  auroraVisible = false,
  onToggleAurora,
  radarAvailable = true,
  ivtAvailable = true,
  ivtVisible = false,
  onToggleIvt,
  chemVisible = false,
  onToggleChem,
}: LayerMatrixDockProps = {}) {
  const activeGroup = useAppStore((s) => s.activeGroup);
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);

  const heatVisible = useAppStore((s) => s.heatVisible);
  const toggleHeat = useAppStore((s) => s.toggleHeat);
  const streakVisible = useAppStore((s) => s.streakVisible);
  const toggleStreaks = useAppStore((s) => s.toggleStreaks);
  const terminatorVisible = useAppStore((s) => s.terminatorVisible);
  const toggleTerminator = useAppStore((s) => s.toggleTerminator);

  const scalarId = useAppStore((s) => s.scalarId);
  const setScalarId = useAppStore((s) => s.setScalarId);

  const level = useAppStore((s) => s.level);
  const [collapsed, setCollapsed] = useState(false);

  const levelLabel = useMemo(
    () => (level === 'surface' ? '地面 10m' : `${level} hPa`),
    [level],
  );

  return (
    <aside
      className={[
        'hud-panel pointer-events-auto absolute left-4 top-4 z-30 flex flex-col rounded-xl',
        collapsed ? 'w-14' : 'w-[236px]',
      ].join(' ')}
      style={{ transition: 'width 180ms ease' }}
    >
      {/* header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        {!collapsed ? (
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold tracking-[0.16em] text-cyan-300">
              LAYER MATRIX
            </p>
            <p className="mt-0.5 truncate text-[9px] uppercase tracking-[0.18em] text-slate-500">
              {levelLabel} · 垂直圈层
            </p>
          </div>
        ) : (
          <Layers size={14} className="mx-auto text-cyan-400/80" />
        )}

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="ml-1 shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-cyan-300"
          aria-label={collapsed ? '展开图层矩阵' : '折叠图层矩阵'}
        >
          <ChevronDown
            size={13}
            style={{
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms ease',
            }}
          />
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="hud-divider mx-3" />

          <div className="max-h-[calc(100vh-320px)] overflow-y-auto px-2 py-2">
            {MATRIX_GROUPS.map((group) => {
              const Icon = GROUP_ICONS[group.id] ?? Layers;
              const isOpen = activeGroup === group.id;

              return (
                <div key={group.id} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => setActiveGroup(isOpen ? '' : group.id)}
                    className={[
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      isOpen
                        ? 'bg-cyan-500/10 text-cyan-200'
                        : 'text-slate-300 hover:bg-white/5',
                    ].join(' ')}
                  >
                    <Icon
                      size={12}
                      className={isOpen ? 'shrink-0 text-cyan-400' : 'shrink-0 text-slate-500'}
                    />
                    <span className="shrink-0 text-[9px] font-mono font-semibold tracking-wider text-slate-500">
                      {group.id}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium leading-tight">
                        {group.title}
                      </span>
                      <span className="block truncate text-[8.5px] uppercase tracking-[0.1em] text-slate-500">
                        {group.subtitle}
                      </span>
                    </span>
                    <ChevronDown
                      size={10}
                      className="shrink-0 text-slate-600"
                      style={{
                        transform: isOpen ? 'rotate(180deg)' : 'none',
                        transition: 'transform 160ms ease',
                      }}
                    />
                  </button>

                  {isOpen ? (
                    <div className="ml-1 mt-0.5 space-y-0.5 border-l border-cyan-500/15 pl-1.5">
                      {group.id === 'L3' ? (
                        <>
                          <LayerRow
                            label="风场粒子流"
                            hint="GPGPU 速度场 · 实时流线"
                            active={streakVisible}
                            onToggle={toggleStreaks}
                            icon={Wind}
                          />
                          <LayerRow
                            label={`标量热力层 · ${SCALAR_FIELDS.find((f) => f.id === scalarId)?.label ?? ''}`}
                            hint="双线性插值热力场"
                            active={heatVisible}
                            onToggle={toggleHeat}
                            icon={Gauge}
                          />

                          <div className="px-1 pb-1 pt-1.5">
                            <p className="hud-label mb-1 px-1">标量变量</p>
                            <div className="grid grid-cols-2 gap-1">
                              {SCALAR_FIELDS.map((field) => {
                                const Icon = SCALAR_ICONS[field.id] ?? CircleDot;
                                const selected = scalarId === field.id;
                                return (
                                  <button
                                    key={field.id}
                                    type="button"
                                    onClick={() => setScalarId(field.id)}
                                    className={[
                                      'flex items-center gap-1 rounded border px-1.5 py-1 transition-colors',
                                      selected
                                        ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200'
                                        : 'border-slate-700/60 text-slate-400 hover:border-slate-600 hover:text-slate-200',
                                    ].join(' ')}
                                  >
                                    <Icon size={9} className="shrink-0" />
                                    <span className="truncate text-[9.5px] font-medium">
                                      {field.label}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </>
                      ) : null}

                      {group.id === 'L6' ? (
                        <>
                          <Stage3Row
                            label="OVATION 极光卵 + Kp"
                            hint="65,160 格点 · 地磁指数"
                            onClick={onOpenSpace}
                          />
                          <LayerRow
                            label="极光卵图层"
                            hint={auroraVisible ? '已显示极光椭圆带' : '点击在面板中开启'}
                            active={auroraVisible}
                            onToggle={() => onToggleAurora?.()}
                            icon={Sparkles}
                          />
                          <LayerRow
                            label="晨昏线阴影"
                            hint="太阳赤纬 · 实时昼夜"
                            active={terminatorVisible}
                            onToggle={toggleTerminator}
                            icon={Sparkles}
                          />
                        </>
                      ) : null}

                      {group.id === 'L2' ? (
                        <>
                          <Stage3Row
                            label="全球降水雷达"
                            hint={
                              radarAvailable
                                ? 'RainViewer · 10 分钟级 · maxzoom 7'
                                : '雷达源不可用'
                            }
                            onClick={radarAvailable ? onOpenRadar : undefined}
                          />
                          <Stage3Row
                            label="PM2.5 / 沙尘 / AOD / UV"
                            hint="CAMS 大气化学场"
                            onClick={onOpenRadar}
                          />
                          <LayerRow
                            label="化学图层显示"
                            hint={chemVisible ? '已叠加化学场' : '点击在面板中开启'}
                            active={chemVisible}
                            onToggle={() => onToggleChem?.()}
                            icon={Droplets}
                          />
                        </>
                      ) : null}

                      {group.id === 'L3' ? (
                        <>
                          <Stage3Row
                            label="水汽输送 IVT"
                            hint="整层水汽通量 · AR Cat 1–5"
                            onClick={onOpenRivers}
                          />
                          <LayerRow
                            label="天河图层显示"
                            hint={ivtVisible ? '已显示水汽通道' : '点击在面板中开启'}
                            active={ivtVisible}
                            onToggle={() => onToggleIvt?.()}
                            icon={Droplets}
                            disabled={!ivtAvailable}
                          />
                          <Stage3Row
                            label="多模型同屏对决"
                            hint="ECMWF / AIFS / GFS / ICON"
                            onClick={onOpenArena}
                          />
                          <Stage3Row
                            label="5880 副高面条图"
                            hint="四模型脊线叠加"
                            onClick={onOpenSpaghetti}
                          />
                        </>
                      ) : null}

                      {group.id === 'L1' ? (
                        <div className="space-y-0.5 px-1 py-1">
                          {['浪高', '涌浪周期', '涌浪方向'].map((label) => (
                            <div
                              key={label}
                              className="flex items-center justify-between rounded px-1 py-1 text-[10px] text-slate-600"
                            >
                              <span>{label}</span>
                              <span className="rounded bg-slate-800/70 px-1 py-px text-[8px] uppercase tracking-wider text-slate-500">
                                Stage 4+
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {group.id === 'L4' ? (
                        <>
                          <Stage3Row
                            label="SIGMET 危险天气"
                            hint="雷暴 / 颠簸 / 积冰 / 火山灰"
                            onClick={onOpenAviation}
                          />
                          <LayerRow
                            label="危险天气图层"
                            hint={hazardsVisible ? '已显示多边形' : '点击在面板中开启'}
                            active={hazardsVisible}
                            onToggle={() => onToggleHazards?.()}
                            icon={Plane}
                          />
                          <Stage3Row
                            label="机场飞行规则 + 侧风"
                            hint="METAR · 跑道侧风解算器"
                            onClick={onOpenAviation}
                          />
                          <LayerRow
                            label="机场 METAR 图层"
                            hint={airportsVisible ? '已显示飞行规则点' : '点击在面板中开启'}
                            active={airportsVisible}
                            onToggle={() => onToggleAirports?.()}
                            icon={Plane}
                          />
                          <LayerRow
                            label="实时航班 OpenSky"
                            hint={flightsVisible ? '已显示航班' : '点击在面板中开启'}
                            active={flightsVisible}
                            onToggle={() => onToggleFlights?.()}
                            icon={CircleDot}
                          />
                        </>
                      ) : null}

                      {group.id === 'L5' ? (
                        <>
                          <Stage3Row
                            label="超级台风数字博物馆"
                            hint="IBTrACS 最佳路径 · 风王竞技"
                            onClick={onOpenCyclone}
                          />
                          <LayerRow
                            label="台风轨迹图层"
                            hint={cycloneVisible ? '已显示轨迹与涡旋' : '点击在面板中开启'}
                            active={cycloneVisible}
                            onToggle={() => onToggleCyclone?.()}
                            icon={CircleDot}
                          />
                          <Stage3Row
                            label="ERA5 气候时间机"
                            hint="1940–2025 变暖条纹"
                            onClick={onOpenClimate}
                          />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
