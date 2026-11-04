/**
 * RenderControls — bottom-right tuning panel for the particle field.
 *
 * Exposes the knobs that actually change what you see: particle density, the
 * two opacities, and master toggles. Values write straight to the store, which
 * the map layer mirrors onto the GPU.
 */

import { useAppStore } from '../state/store';
import { PARTICLE_COUNT_MIN, PARTICLE_COUNT_MAX } from '../layers/WindParticleLayer';

export function RenderControls() {
  const particleCount = useAppStore((s) => s.particleCount);
  const setParticleCount = useAppStore((s) => s.setParticleCount);
  const heatOpacity = useAppStore((s) => s.heatOpacity);
  const setHeatOpacity = useAppStore((s) => s.setHeatOpacity);
  const streakOpacity = useAppStore((s) => s.streakOpacity);
  const setStreakOpacity = useAppStore((s) => s.setStreakOpacity);

  return (
    <div className="hud-panel pointer-events-auto absolute bottom-[126px] left-4 z-20 w-[236px] rounded-xl p-3">
      <p className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-slate-300">
        渲染调参
      </p>

      <label className="block">
        <span className="flex items-center justify-between">
          <span className="hud-label">粒子数量</span>
          <span className="hud-value text-[9px] text-cyan-300">
            {particleCount.toLocaleString('en-US')}
          </span>
        </span>
        <input
          type="range"
          min={PARTICLE_COUNT_MIN}
          max={PARTICLE_COUNT_MAX}
          step={1000}
          value={particleCount}
          onChange={(event) => setParticleCount(Number(event.target.value))}
          className="mt-1 w-full"
        />
      </label>

      <label className="mt-2 block">
        <span className="flex items-center justify-between">
          <span className="hud-label">热力层不透明度</span>
          <span className="hud-value text-[9px] text-cyan-300">
            {Math.round(heatOpacity * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(heatOpacity * 100)}
          onChange={(event) => setHeatOpacity(Number(event.target.value) / 100)}
          className="mt-1 w-full"
        />
      </label>

      <label className="mt-2 block">
        <span className="flex items-center justify-between">
          <span className="hud-label">流线不透明度</span>
          <span className="hud-value text-[9px] text-cyan-300">
            {Math.round(streakOpacity * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(streakOpacity * 100)}
          onChange={(event) => setStreakOpacity(Number(event.target.value) / 100)}
          className="mt-1 w-full"
        />
      </label>

      <div className="hud-divider my-2" />
      <p className="text-[8px] leading-relaxed text-slate-600">
        粒子为无状态流线：位置由编号与时钟推导，拖动地球时不产生拖影。
      </p>
    </div>
  );
}
