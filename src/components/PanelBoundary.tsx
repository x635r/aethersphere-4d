/**
 * ErrorBoundary — keeps a rendering fault in one HUD panel from taking down the
 * map. Any panel that throws renders a compact fallback instead.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: Error | null;
}

export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[aether] ${this.props.label} crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="hud-panel pointer-events-auto rounded-lg border-amber-500/30 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <AlertOctagon size={11} className="text-amber-400" />
            <span className="text-[10px] font-medium text-amber-200">
              {this.props.label} 暂时不可用
            </span>
          </div>
          <p className="mt-1 text-[8.5px] leading-relaxed text-slate-500">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-1.5 rounded bg-amber-500/15 px-2 py-0.5 text-[8.5px] text-amber-200 transition-colors hover:bg-amber-500/25"
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * AppBoundary — the outermost guard. If the shell itself fails, show a message
 * rather than a blank screen, and offer a reload.
 */
export class AppBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[aether] application crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-[#030712] p-6">
          <div className="hud-panel max-w-lg rounded-xl p-6">
            <div className="flex items-center gap-2">
              <AlertOctagon size={16} className="text-rose-400" />
              <h1 className="text-sm font-semibold text-rose-200">AetherSphere 发生异常</h1>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              {this.state.error.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md bg-cyan-500/20 px-3 py-1.5 text-[11px] text-cyan-200 transition-colors hover:bg-cyan-500/30"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
