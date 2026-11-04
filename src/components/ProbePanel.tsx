/**
 * ProbePanel — the crosshair readout.
 *
 * Shows the exact wind direction/speed and scalar value at the cursor, sampled
 * with the same bilinear filter the GPU uses. Direction is rendered both as a
 * numeric bearing and as a rotating arrow, and speed can be switched between
 * m/s, km/h and knots.
 */

import { Crosshair, Navigation } from 'lucide-react';
import { useAppStore, convertSpeed, speedUnitLabel } from '../state/store';
import { compassLabel, compassLabelZh } from '../core/geo';
import { scalarFieldMeta } from '../core/levels';
import { RAMPS, rampForScalar } from '../render/ramps';
import { colorAtFraction } from './ColorbarLegend';

function formatCoord(value: number, positive: string, negative: string): string {
  const hemisphere = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}°${hemisphere}`;
}

export function ProbePanel() {
  const probe = useAppStore((s) => s.probe);
  const speedUnit = useAppStore((s) => s.speedUnit);
  const setSpeedUnit = useAppStore((s) => s.setSpeedUnit);
  const fieldSet = useAppStore((s) => s.fieldSet);

  if (!probe) {
    return (
      <div
        className="hud-panel pointer-events-none absolute right-4 z-20 w-[208px] rounded-xl px-3 py-2.5 opacity-80"
        style={{ top: 'calc(1rem + var(--elevator-h, 380px))' }}
      >
        <div className="flex items-center gap-1.5">
          <Crosshair size={11} className="text-cyan-500/70" />
          <p className="hud-label">十字探针</p>
        </div>
        <p className="mt-1.5 text-[9.5px] leading-relaxed text-slate-500">
          将指针移到地球上任意位置，读取该处的风场与标量数值。
        </p>
      </div>
    );
  }

  const meta = scalarFieldMeta(probe.scalarId);
  const ramp = RAMPS[rampForScalar(probe.scalarId)];

  const fraction =
    fieldSet && fieldSet.scalarRange.max > fieldSet.scalarRange.min
      ? Math.max(
          0,
          Math.min(
            1,
            (probe.scalarValue - fieldSet.scalarRange.min) /
              (fieldSet.scalarRange.max - fieldSet.scalarRange.min),
          ),
        )
      : 0.5;

  const scalarColor = colorAtFraction(probe.scalarId, fraction);
  const speedValue = convertSpeed(probe.windSpeedMs, speedUnit);
  const levelLabel =
    probe.level === 'surface' ? '地面 10m' : `${probe.level} hPa`;
  const altitude =
    probe.altitudeM !== null
      ? `${probe.altitudeM.toLocaleString('en-US')} m`
      : '—';


  return (
    <div
      className="hud-panel pointer-events-auto absolute right-4 z-20 w-[208px] rounded-xl p-3"
      style={{ top: 'calc(1rem + var(--elevator-h, 380px))' }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Crosshair size={11} className="text-cyan-400" />
          <p className="hud-label text-cyan-300/90">十字探针</p>
        </div>
        <span className="hud-value text-[8.5px] text-slate-500">{levelLabel}</span>
      </div>

      <p className="hud-value mb-2 text-[10px] text-slate-300">
        {formatCoord(probe.lat, 'N', 'S')} · {formatCoord(probe.lng, 'E', 'W')}
      </p>

      {/* wind */}
      <div className="rounded-lg bg-cyan-400/5 p-2">
        <div className="flex items-center justify-between">
          <span className="hud-label">风向 / 风速</span>
          <div className="flex items-center gap-0.5">
            {(['ms', 'kmh', 'kt'] as const).map((unit) => (
              <button
                key={unit}
                type="button"
                onClick={() => setSpeedUnit(unit)}
                className={[
                  'rounded px-1 py-px text-[8px] font-mono transition-colors',
                  speedUnit === unit
                    ? 'bg-cyan-400/25 text-cyan-200'
                    : 'text-slate-500 hover:text-slate-300',
                ].join(' ')}
              >
                {speedUnitLabel(unit)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          {/* rotating arrow: points where the wind blows TO */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/25 bg-slate-950/60">
            <Navigation
              size={14}
              className="text-cyan-300"
              fill="currentColor"
              style={{
                transform: `rotate(${(probe.windDirection + 180).toFixed(1)}deg)`,
                transition: 'transform 90ms linear',
              }}
            />
          </div>

          <div className="min-w-0">
            <p className="hud-value text-[15px] font-semibold leading-none text-cyan-100">
              {speedValue.toFixed(speedUnit === 'ms' ? 1 : 0)}
              <span className="ml-1 text-[9px] font-normal text-cyan-400/70">
                {speedUnitLabel(speedUnit)}
              </span>
            </p>
            <p className="mt-1 truncate text-[9.5px] text-slate-400">
              {probe.windDirection.toFixed(0)}° · {compassLabel(probe.windDirection)}
              <span className="ml-1 text-slate-500">
                ({compassLabelZh(probe.windDirection)}风)
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* scalar */}
      <div className="mt-1.5 space-y-1 rounded-lg bg-white/[0.03] p-2">
        <div className="flex items-center justify-between">
          <span className="hud-label">{meta.label}</span>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: scalarColor, boxShadow: `0 0 8px ${scalarColor}` }}
          />
        </div>
        <p className="hud-value text-[13px] font-medium" style={{ color: scalarColor }}>
          {probe.scalarValue.toFixed(
            probe.scalarId === 'vertical_velocity' ? 2 : 1,
          )}
          <span className="ml-1 text-[9px] font-normal opacity-60">{meta.unit}</span>
        </p>

        {/* position on ramp */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${(fraction * 100).toFixed(1)}%`,
              background: scalarColor,
            }}
          />
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[8.5px] text-slate-600">
        <span>等压面高度</span>
        <span className="hud-value">{altitude}</span>
      </div>

      <p className="mt-1 text-[8px] uppercase tracking-[0.12em] text-slate-700">
        {ramp.label} ramp
      </p>
    </div>
  );
}
