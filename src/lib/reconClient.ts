import type { Mesh } from './mesh';
import type { RasterImage } from './image';
import type { SegmentOptions } from './segment';
import type { CarveOptions } from './carve';
import type { HeightfieldOptions } from './heightfield';
import type { ViewDiagnostic, WireImage, WirePaint, WorkerRequest, WorkerResponse } from './workerTypes';

export interface ProgressReport {
  fraction: number;
  label: string;
}

export interface SegmentPreview {
  mask: Uint8Array;
  width: number;
  height: number;
  coverage: number;
  usedThreshold: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface MeshResult {
  mesh: Mesh;
  diagnostics: ViewDiagnostic[];
}

type Pending = {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  onProgress?: (p: ProgressReport) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/recon.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') {
      entry.onProgress?.({ fraction: msg.fraction, label: msg.label });
      return;
    }
    pending.delete(msg.id);
    if (msg.type === 'error') {
      entry.reject(new Error(msg.message));
    } else if (msg.type === 'segment') {
      entry.resolve({
        mask: new Uint8Array(msg.mask),
        width: msg.width,
        height: msg.height,
        coverage: msg.coverage,
        usedThreshold: msg.usedThreshold,
        bbox: msg.bbox,
      } as never);
    } else {
      entry.resolve({
        mesh: { positions: new Float32Array(msg.positions), indices: new Uint32Array(msg.indices) },
        diagnostics: msg.diagnostics,
      } as never);
    }
  };
  worker.onerror = (e) => {
    for (const [, entry] of pending) entry.reject(new Error(e.message || 'Worker crashed'));
    pending.clear();
  };
  return worker;
}

/** `Omit` over a union collapses it, so distribute across the members. */
type RequestBody = WorkerRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

function send<T>(request: RequestBody, transfer: Transferable[], onProgress?: (p: ProgressReport) => void): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress });
    getWorker().postMessage({ ...request, id } as WorkerRequest, transfer);
  });
}

function toWire(image: RasterImage): WireImage {
  // Copy so the caller keeps its pixels after we transfer.
  const copy = new Uint8ClampedArray(image.data);
  return { data: copy.buffer as ArrayBuffer, width: image.width, height: image.height };
}

function paintToWire(paint?: { width: number; height: number; data: Uint8Array }): WirePaint | undefined {
  if (!paint) return undefined;
  const copy = new Uint8Array(paint.data);
  return { data: copy.buffer as ArrayBuffer, width: paint.width, height: paint.height };
}

export function segmentPreview(
  image: RasterImage,
  options: Partial<SegmentOptions>,
  paint?: { width: number; height: number; data: Uint8Array },
): Promise<SegmentPreview> {
  const wire = toWire(image);
  const wirePaint = paintToWire(paint);
  const transfer = [wire.data, ...(wirePaint ? [wirePaint.data] : [])];
  return send<SegmentPreview>({ type: 'segment', image: wire, options, paint: wirePaint }, transfer);
}

export interface ReconstructView {
  image: RasterImage;
  angleDeg: number;
  options: Partial<SegmentOptions>;
  paint?: { width: number; height: number; data: Uint8Array };
}

export function reconstruct(
  views: ReconstructView[],
  carve: Partial<CarveOptions>,
  onProgress?: (p: ProgressReport) => void,
): Promise<MeshResult> {
  const transfer: Transferable[] = [];
  const wireViews = views.map((v) => {
    const wire = toWire(v.image);
    const paint = paintToWire(v.paint);
    transfer.push(wire.data);
    if (paint) transfer.push(paint.data);
    return { ...wire, angleDeg: v.angleDeg, options: v.options, paint };
  });
  return send<MeshResult>({ type: 'reconstruct', views: wireViews, carve }, transfer, onProgress);
}

export function heightfield(
  image: RasterImage,
  options: Partial<HeightfieldOptions>,
  useMask: boolean,
  segment?: Partial<SegmentOptions>,
  paint?: { width: number; height: number; data: Uint8Array },
  onProgress?: (p: ProgressReport) => void,
): Promise<MeshResult> {
  const wire = toWire(image);
  const wirePaint = paintToWire(paint);
  const transfer = [wire.data, ...(wirePaint ? [wirePaint.data] : [])];
  return send<MeshResult>(
    { type: 'heightfield', image: wire, options, useMask, segment, paint: wirePaint },
    transfer,
    onProgress,
  );
}
