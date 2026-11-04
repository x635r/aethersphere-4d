/**
 * AnalysisToolbar — the mode switch for the Stage 2 instruments.
 *
 * Three mutually exclusive modes:
 *   probe   — the Stage 1 crosshair readout (default)
 *   sounding— click the globe to open a Skew-T for that column
 *   section — click 2–5 points to slice the atmosphere along them
 */

import { Crosshair, Thermometer, Scissors, Check, X } from 'lucide-react';
import type { ToolMode } from '../hooks/useAnalysisTools';

export interface AnalysisToolbarProps {
  mode: ToolMode;
  onChange: (mode: ToolMode) => void;
  /** Nodes already placed while drafting a section. */
  draftCount: number;
  onFinishSection: () => void;
  onCancelSection: () => void;
  disabled?: boolean;
}

export function AnalysisToolbar({
  mode,
  onChange,
  draftCount,
  onFinishSection,
  onCancelSection,
  disabled,
}: AnalysisToolbarProps) {
  const tools: { id: ToolMode; label: string; hint: string; icon: typeof Crosshair; key: string }[] = [
    { id: 'probe', label: '探针', hint: '读取任意点的风与标量', icon: Crosshair, key: 'Esc' },
    { id: 'sounding', label: '探空气球', hint: '点击地球生成 Skew-T 斜温图', icon: Thermometer, key: 'S' },
    { id: 'section', label: '大气切片', hint: '点击 2–5 个节点横切大气', icon: Scissors, key: 'X' },
  ];

  return (
    <div className="hud-panel pointer-events-auto absolute left-1/2 top-[calc(1rem+64px)] z-30 -translate-x-1/2 rounded-xl px-1.5 py-1.5">
      <div className="flex items-center gap-1">
        {tools.map((tool) => {
          const Icon = tool.icon;
          const active = mode === tool.id;

          return (
            <button
              key={tool.id}
              type="button"
              onClick={() => onChange(tool.id)}
              disabled={disabled}
              title={`${tool.hint} (${tool.key})`}
              className={[
                'group relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-all',
                active
                  ? 'bg-cyan-400/18 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                disabled ? 'cursor-not-allowed opacity-40' : '',
              ].join(' ')}
            >
              <Icon size={12} />
              <span className="text-[10px] font-medium">{tool.label}</span>
              <span
                className={[
                  'rounded px-1 py-px text-[7.5px] font-mono',
                  active ? 'bg-cyan-400/25 text-cyan-100' : 'bg-slate-800/80 text-slate-500',
                ].join(' ')}
              >
                {tool.key}
              </span>
            </button>
          );
        })}

        {/* in-progress section hint */}
        {mode === 'section' ? (
          <>
            <div className="mx-1 h-5 w-px bg-gradient-to-b from-transparent via-slate-600/40 to-transparent" />

            <span className="px-1.5 text-[9px] text-slate-500">
              已放置 <span className="hud-value text-amber-300">{draftCount}</span> / 5
            </span>

            <button
              type="button"
              onClick={onFinishSection}
              disabled={draftCount < 2}
              className={[
                'flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] transition-colors',
                draftCount >= 2
                  ? 'bg-fuchsia-400/20 text-fuchsia-200 hover:bg-fuchsia-400/30'
                  : 'cursor-not-allowed text-slate-600',
              ].join(' ')}
            >
              <Check size={9} />
              切片
            </button>

            <button
              type="button"
              onClick={onCancelSection}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] text-slate-500 transition-colors hover:bg-white/5 hover:text-rose-300"
            >
              <X size={9} />
              清除
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
