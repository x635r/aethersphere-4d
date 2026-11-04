/**
 * ChronosBar — the bottom cross-scale timeline.
 *
 * Owns playback. The animation clock advances the fractional frame index at the
 * selected multiplier and writes whole indices into the store, which the map
 * layer picks up. Keeping the fractional cursor local means playback does not
 * re-render the whole HUD 60 times a second.
 */

import { useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, Clock, Globe2 } from 'lucide-react';
import { useAppStore } from '../state/store';

function formatStamp(epochMs: number | undefined, mode: 'utc' | 'local'): string {
  if (!epochMs) return '—';
  const date = new Date(epochMs);

  if (mode === 'utc') {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00Z`;
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function dayLabel(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

export function ChronosBar() {
  const times = useAppStore((s) => s.times);
  const timeIndex = useAppStore((s) => s.timeIndex);
  const setTimeIndex = useAppStore((s) => s.setTimeIndex);
  const playing = useAppStore((s) => s.playing);
  const togglePlaying = useAppStore((s) => s.togglePlaying);
  const speed = useAppStore((s) => s.speed);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const timeMode = useAppStore((s) => s.timeMode);
  const setTimeMode = useAppStore((s) => s.setTimeMode);

  // Fractional cursor kept out of the store so playback stays cheap.
  const cursorRef = useRef(timeIndex);
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);

  const count = times.length;

  useEffect(() => {
    cursorRef.current = timeIndex;
  }, [timeIndex]);

  useEffect(() => {
    if (!playing || count === 0) return;

    lastTickRef.current = performance.now();

    const animate = () => {
      const now = performance.now();
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      // One step per second at 1x; multipliers scale that rate.
      cursorRef.current += dt * speed;

      if (cursorRef.current >= count) {
        cursorRef.current = 0;
      }

      const whole = Math.floor(cursorRef.current);
      if (whole !== useAppStore.getState().timeIndex) {
        setTimeIndex(whole);
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, count, setTimeIndex]);

  const current = times[timeIndex];
  const first = times[0];
  const last = times[count - 1];

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-30 w-[min(600px,calc(100vw-2rem))] -translate-x-1/2">
      <div className="hud-panel rounded-xl px-3.5 py-2.5">
        {/* row 1: transport + clock */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTimeIndex(0)}
              disabled={count === 0}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-cyan-300 disabled:opacity-30"
              aria-label="回到起点"
            >
              <SkipBack size={13} />
            </button>

            <button
              type="button"
              onClick={togglePlaying}
              disabled={count === 0}
              className={[
                'flex h-8 w-8 items-center justify-center rounded-full transition-all disabled:opacity-30',
                playing
                  ? 'bg-cyan-400 text-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.6)]'
                  : 'bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25',
              ].join(' ')}
              aria-label={playing ? '暂停' : '播放'}
            >
              {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            </button>

            <button
              type="button"
              onClick={() => setTimeIndex(count - 1)}
              disabled={count === 0}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-cyan-300 disabled:opacity-30"
              aria-label="跳到末点"
            >
              <SkipForward size={13} />
            </button>
          </div>

          <div className="hud-divider h-6 w-px flex-none bg-gradient-to-b from-transparent via-cyan-500/25 to-transparent" />

          <div className="min-w-0 flex-1">
            <p className="hud-value truncate text-[13px] font-medium text-cyan-100 text-glow">
              {formatStamp(current, timeMode)}
            </p>
            <p className="hud-label mt-0.5">
              {count > 0 ? `第 ${timeIndex + 1} / ${count} 帧 · 逐小时` : '等待数据'}
            </p>
          </div>

          <div className="flex items-center gap-1">
            {[1, 4, 12].map((multiplier) => (
              <button
                key={multiplier}
                type="button"
                onClick={() => setSpeed(multiplier)}
                className={[
                  'rounded px-1.5 py-0.5 text-[9.5px] font-mono transition-colors',
                  speed === multiplier
                    ? 'bg-cyan-400/20 text-cyan-200'
                    : 'text-slate-500 hover:text-slate-300',
                ].join(' ')}
              >
                {multiplier}x
              </button>
            ))}

            <div className="hud-divider mx-1 h-5 w-px bg-gradient-to-b from-transparent via-slate-600/40 to-transparent" />

            <button
              type="button"
              onClick={() => setTimeMode(timeMode === 'utc' ? 'local' : 'utc')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] text-slate-400 transition-colors hover:text-cyan-300"
            >
              {timeMode === 'utc' ? <Globe2 size={9} /> : <Clock size={9} />}
              {timeMode === 'utc' ? 'UTC' : '本地'}
            </button>
          </div>
        </div>

        {/* row 2: scrubber */}
        <div className="mt-2">
          <input
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            step={1}
            value={Math.min(timeIndex, Math.max(0, count - 1))}
            onChange={(event) => {
              const next = Number(event.target.value);
              cursorRef.current = next;
              setTimeIndex(next);
            }}
            disabled={count === 0}
            className="w-full"
            aria-label="时间轴"
          />

          <div className="mt-1 flex items-center justify-between">
            <span className="hud-value text-[8.5px] text-slate-600">
              {first !== undefined ? dayLabel(first) : '—'}
            </span>

            {/* Hour ticks for orientation along the bar. */}
            <div className="flex items-center gap-1.5 opacity-45">
              {times
                .filter((_, index) => index % 24 === 0)
                .map((stamp) => (
                  <span key={stamp} className="hud-value text-[8px] text-slate-500">
                    {dayLabel(stamp)}
                  </span>
                ))}
            </div>

            <span className="hud-value text-[8.5px] text-slate-600">
              {last !== undefined ? dayLabel(last) : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
