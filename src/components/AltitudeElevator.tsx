/**
 * AltitudeElevator — the top-right altitude selector.
 *
 * Buttons are stacked like an elevator panel, ordered from the surface upward,
 * with each level's standard-atmosphere altitude on the right. Selecting a
 * button drives the same `level` state the weather pipeline reads.
 */

import { useEffect, useRef } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { ELEVATOR_LEVELS } from '../core/levels';
import { useAppStore } from '../state/store';

export function AltitudeElevator() {
  const level = useAppStore((s) => s.level);
  const setLevel = useAppStore((s) => s.setLevel);
  const ref = useRef<HTMLDivElement | null>(null);

  // Publish this panel's real height so the probe card can stack below it
  // instead of relying on a hard-coded offset that breaks at other viewports.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const publish = () => {
      document.documentElement.style.setProperty(
        '--elevator-h',
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // Present top-of-atmosphere first, like a building's top floor.
  const ordered = [...ELEVATOR_LEVELS].reverse();

  return (
    <div
      ref={ref}
      className="hud-panel pointer-events-auto absolute right-4 top-4 z-30 w-[150px] rounded-xl"
    >
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3">
        <ArrowDown size={11} className="text-cyan-400/70" />
        <p className="text-[10px] font-semibold tracking-[0.16em] text-cyan-300">
          ALTITUDE
        </p>
        <ArrowUp size={11} className="text-cyan-400/70" />
      </div>
      <p className="px-3 pb-2 text-[8.5px] uppercase tracking-[0.18em] text-slate-500">
        等压面升降器
      </p>

      <div className="hud-divider mx-2" />

      <div className="space-y-0.5 p-1.5">
        {ordered.map((entry) => {
          const selected = level === entry.level;
          const altitudeLabel =
            entry.level === 'surface'
              ? '0 m'
              : `${entry.altitude.toLocaleString('en-US')} m`;

          return (
            <button
              key={String(entry.level)}
              type="button"
              onClick={() => setLevel(entry.level)}
              className={[
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 transition-all',
                selected
                  ? 'bg-cyan-400/15 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
              ].join(' ')}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={[
                    'h-1.5 w-1.5 rounded-full transition-colors',
                    selected ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]' : 'bg-slate-700',
                  ].join(' ')}
                />
                <span className="hud-value text-[11px] font-medium">{entry.label}</span>
              </span>
              <span
                className={[
                  'hud-value text-[8.5px]',
                  selected ? 'text-cyan-300/90' : 'text-slate-600',
                ].join(' ')}
              >
                {altitudeLabel}
              </span>
            </button>
          );
        })}
      </div>

      <div className="hud-divider mx-2" />
      <p className="px-3 py-2 text-[8px] leading-relaxed text-slate-600">
        高度为 ICAO 标准大气近似值
      </p>
    </div>
  );
}
