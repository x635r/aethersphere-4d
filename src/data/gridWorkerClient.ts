/**
 * Worker bridge with request coalescing and cancellation.
 *
 * A request id is tracked so that a stale response from a superseded request
 * (the user scrubbed the timeline, changed level, or switched scalar) never
 * overwrites newer data.
 */

import type {
  RawLocationPayload,
  SerialisedFieldSet,
  WorkerRequest,
  WorkerResponse,
} from '../core/types';
import type { GridSpec } from '../core/types';
import type { ScalarFieldId } from '../core/levels';

let worker: Worker | null = null;
let nextId = 1;

const pending = new Map<
  number,
  {
    resolve: (value: SerialisedFieldSet) => void;
    reject: (reason: Error) => void;
    superseded: boolean;
  }
>();

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('../workers/weatherGrid.worker.ts', import.meta.url), {
    type: 'module',
    name: 'aether-weather-grid',
  });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);

    if (entry.superseded) return;

    if (event.data.ok && event.data.fieldSet) {
      entry.resolve(event.data.fieldSet);
    } else {
      entry.reject(new Error(event.data.error ?? '天气网格构建失败'));
    }
  };

  worker.onerror = (event) => {
    const reason = new Error(event.message || '天气网格 Worker 崩溃');
    for (const entry of pending.values()) {
      if (!entry.superseded) entry.reject(reason);
    }
    pending.clear();
  };

  return worker;
}

export interface BuildFieldArgs {
  grid: GridSpec;
  level: number | 'surface';
  scalarId: ScalarFieldId;
  times: string[];
  payload: RawLocationPayload[];
  model: string;
}

/** Reject every in-flight request; call when a new request supersedes them. */
function supersedeAll(): void {
  for (const entry of pending.values()) {
    entry.superseded = true;
  }
}

export function buildField(args: BuildFieldArgs): Promise<SerialisedFieldSet> {
  supersedeAll();

  const instance = ensureWorker();
  const id = nextId;
  nextId += 1;

  const request: WorkerRequest = {
    id,
    kind: 'build',
    grid: args.grid,
    level: args.level,
    scalarId: args.scalarId,
    times: args.times,
    payload: args.payload,
    model: args.model,
  };

  return new Promise<SerialisedFieldSet>((resolve, reject) => {
    pending.set(id, { resolve, reject, superseded: false });
    instance.postMessage(request);
  });
}

export function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pending.clear();
}
