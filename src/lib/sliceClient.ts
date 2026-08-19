import type { Mesh } from './mesh';
import type { PrintSettings } from './slicer/settings';
import type { PreviewData, SliceStats } from './slicer';
import type { SliceResponse } from '../workers/slice.worker';

export interface SliceOutcome {
  gcode: string;
  stats: SliceStats;
  preview: PreviewData;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: SliceOutcome) => void; reject: (e: Error) => void; onProgress?: (f: number, l: string) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/slice.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<SliceResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') {
      entry.onProgress?.(msg.fraction, msg.label);
      return;
    }
    pending.delete(msg.id);
    if (msg.type === 'error') entry.reject(new Error(msg.message));
    else entry.resolve({ gcode: msg.gcode, stats: msg.stats, preview: msg.preview });
  };
  worker.onerror = (e) => {
    for (const [, entry] of pending) entry.reject(new Error(e.message || 'Slicer crashed'));
    pending.clear();
  };
  return worker;
}

export function slice(
  mesh: Mesh,
  settings: PrintSettings,
  onProgress?: (fraction: number, label: string) => void,
): Promise<SliceOutcome> {
  const id = nextId++;
  const positions = new Float32Array(mesh.positions).buffer;
  const indices = new Uint32Array(mesh.indices).buffer;
  return new Promise<SliceOutcome>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, positions, indices, settings }, [positions, indices]);
  });
}
