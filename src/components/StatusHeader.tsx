/**
 * StatusHeader — the top-center identity strip plus the projection switch and
 * load-state indicator. This is the app's "are we live?" surface: it reports
 * the model set, the billed call count and any upstream error in plain terms.
 */

import { Globe2, Map as MapIcon, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../state/store';

export function StatusHeader() {
  const projection = useAppStore((s) => s.projection);
  const setProjection = useAppStore((s) => s.setProjection);
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const fieldSet = useAppStore((s) => s.fieldSet);
  const modelLabel = useAppStore((s) => s.modelLabel);
  const billedCalls = useAppStore((s) => s.billedCalls);
  const cacheHit = useAppStore((s) => s.cacheHit);
  const synthetic = useAppStore((s) => s.synthetic);
  const probe = useAppStore((s) => s.probe);

  const frameCount = fieldSet?.times.length ?? 0;

  const indicator = (() => {
    if (status === 'loading') {
      return {
        icon: Loader2,
        className: 'text-cyan-300',
        text: '正在同步全球格点…',
      };
    }
    if (synthetic) {
      return {
        icon: AlertTriangle,
        className: 'text-amber-300',
        text: '离线演示场（非真实预报）',
      };
    }
    if (error) {
      return {
        icon: AlertTriangle,
        className: 'text-amber-300',
        text: error,
      };
    }
    if (fieldSet) {
      return {
        icon: CheckCircle2,
        className: 'text-emerald-300',
        text: `${frameCount} 帧已就绪 · ${billedCalls > 0 ? `${billedCalls} 格点` : '本地缓存'}`,
      };
    }
    return { icon: Loader2, className: 'text-slate-500', text: '等待初始化' };
  })();

  const IndicatorIcon = indicator.icon;

  return (
    <header className="pointer-events-none absolute left-1/2 top-4 z-40 w-[min(620px,calc(100vw-2rem))] -translate-x-1/2">
      <div className="hud-panel pointer-events-auto rounded-xl px-3.5 py-2">
        <div className="flex items-center gap-3">
          {/* identity */}
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <h1 className="truncate text-[13px] font-semibold tracking-[0.06em] text-cyan-100">
                AETHERSPHERE
              </h1>
              <span className="text-[10px] font-mono font-semibold text-cyan-400/80">4D</span>
            </div>
            <p className="truncate text-[8.5px] uppercase tracking-[0.16em] text-slate-500">
              苍穹四维大气数字孪生 · {modelLabel}
            </p>
          </div>

          <div className="h-6 w-px bg-gradient-to-b from-transparent via-cyan-500/25 to-transparent" />

          {/* live indicator */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <IndicatorIcon
              size={11}
              className={`${indicator.className} shrink-0 ${status === 'loading' ? 'animate-aether-spin' : ''}`}
            />
            <p
              className={`truncate text-[9.5px] ${error || synthetic ? 'text-amber-300' : 'text-slate-400'}`}
            >
              {indicator.text}
            </p>
          </div>

          {/* projection switch */}
          <div className="flex shrink-0 items-center rounded-md bg-slate-900/70 p-0.5">
            <button
              type="button"
              onClick={() => setProjection('globe')}
              className={[
                'flex items-center gap-1 rounded px-1.5 py-1 text-[9px] transition-colors',
                projection === 'globe'
                  ? 'bg-cyan-400/20 text-cyan-200'
                  : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
              title="3D 球体投影"
            >
              <Globe2 size={10} />
              3D
            </button>
            <button
              type="button"
              onClick={() => setProjection('mercator')}
              className={[
                'flex items-center gap-1 rounded px-1.5 py-1 text-[9px] transition-colors',
                projection === 'mercator'
                  ? 'bg-cyan-400/20 text-cyan-200'
                  : 'text-slate-500 hover:text-slate-300',
              ].join(' ')}
              title="墨卡托平面投影"
            >
              <MapIcon size={10} />
              2D
            </button>
          </div>
        </div>

        {cacheHit && fieldSet ? (
          <p className="mt-1 text-[8px] text-emerald-400/60">本次数据来自本地缓存，未消耗 API 额度</p>
        ) : null}

        {probe ? (
          <p className="mt-1 text-[8px] text-slate-600">
            探针：{probe.lat.toFixed(2)}°, {probe.lng.toFixed(2)}°
          </p>
        ) : null}
      </div>
    </header>
  );
}
