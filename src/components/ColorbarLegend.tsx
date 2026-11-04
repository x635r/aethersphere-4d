/**
 * ColorbarLegend — binds the shader's ramp to a visible legend.
 *
 * The gradient is generated from the same stop list the GPU LUT is built from,
 * so the bar can never drift out of sync with what is rendered.
 */

import { useMemo } from 'react';
import { useAppStore } from '../state/store';
import { RAMPS, cssGradient, rampTicks, rampForScalar, sampleRamp } from '../render/ramps';
import { scalarFieldMeta, LEVEL_ALTITUDE_M } from '../core/levels';
import type { ScalarFieldId } from '../core/levels';

function decimalsFor(scalarId: ScalarFieldId): number {
  switch (scalarId) {
    case 'geopotential_height':
      return 0;
    case 'relative_humidity':
    case 'cloud_cover':
      return 0;
    case 'vertical_velocity':
      return 2;
    default:
      return 1;
  }
}

/** Convert a raw scalar into the unit shown on the legend. */
function displayValue(scalarId: ScalarFieldId, raw: number): number {
  if (scalarId === 'wind_speed') return raw; // already m/s
  return raw;
}

export function ColorbarLegend() {
  const fieldSet = useAppStore((s) => s.fieldSet);
  const level = useAppStore((s) => s.level);
  const scalarId = useAppStore((s) => s.scalarId);
  const heatVisible = useAppStore((s) => s.heatVisible);

  const rampId = rampForScalar(fieldSet?.scalarId ?? scalarId);
  const ramp = RAMPS[rampId];
  const meta = scalarFieldMeta(fieldSet?.scalarId ?? scalarId);

  const gradient = useMemo(() => cssGradient(ramp.stops), [ramp]);

  const range = fieldSet?.scalarRange ?? { min: 0, max: 1 };
  const decimals = decimalsFor(fieldSet?.scalarId ?? scalarId);
  const ticks = rampTicks(
    displayValue(fieldSet?.scalarId ?? scalarId, range.min),
    displayValue(fieldSet?.scalarId ?? scalarId, range.max),
    5,
    decimals,
  );

  // Horizontal marker for the last probe sample.
  const probe = useAppStore((s) => s.probe);
  const probePosition =
    probe && fieldSet && fieldSet.scalarRange.max > fieldSet.scalarRange.min
      ? Math.max(
          0,
          Math.min(
            1,
            (probe.scalarValue - fieldSet.scalarRange.min) /
              (fieldSet.scalarRange.max - fieldSet.scalarRange.min),
          ),
        )
      : null;

  const levelLabel = level === 'surface' ? '地面 10m' : `${level} hPa`;
  const altitude =
    level === 'surface' ? '0 m 海拔' : `${(LEVEL_ALTITUDE_M[level] ?? 0).toLocaleString('en-US')} m`;

  return (
    <div className="hud-panel pointer-events-auto absolute bottom-4 left-4 z-20 w-[236px] rounded-xl p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-300">
          {meta.label}
        </p>
        <span className="hud-value text-[9px] text-cyan-400/80">{meta.unit}</span>
      </div>

      {/* gradient bar */}
      <div className="relative">
        <div
          className="h-2.5 w-full rounded-full"
          style={{
            background: gradient,
            opacity: heatVisible ? 1 : 0.3,
            boxShadow: heatVisible ? '0 0 12px rgba(34,211,238,0.18)' : 'none',
          }}
        />

        {/* probe marker */}
        {probePosition !== null ? (
          <div
            className="absolute -top-1 h-[18px] w-[2px] bg-white shadow-[0_0_6px_rgba(255,255,255,0.95)]"
            style={{ left: `calc(${(probePosition * 100).toFixed(2)}% - 1px)` }}
          />
        ) : null}
      </div>

      {/* tick labels */}
      <div className="mt-1 flex items-start justify-between">
        {ticks.map((tick, index) => (
          <span
            key={index}
            className="hud-value text-[8.5px] text-slate-500"
            style={{
              color:
                probePosition !== null && Math.abs(tick.t - probePosition) < 0.12
                  ? '#a5f3fc'
                  : undefined,
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <div className="hud-divider my-2" />

      <div className="flex items-center justify-between">
        <span className="hud-label">{levelLabel}</span>
        <span className="hud-value text-[8.5px] text-slate-500">{altitude}</span>
      </div>

      {!heatVisible ? (
        <p className="mt-1.5 text-[8.5px] text-amber-400/70">热力层已关闭（仅显示粒子流）</p>
      ) : null}
    </div>
  );
}

/** Exposed for the probe card to reuse the exact same colour. */
export function colorAtFraction(scalarId: ScalarFieldId, fraction: number): string {
  const ramp = RAMPS[rampForScalar(scalarId)];
  const [r, g, b] = sampleRamp(ramp.stops, fraction);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}
