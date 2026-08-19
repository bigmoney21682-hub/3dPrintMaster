/// <reference lib="webworker" />
import type { Mesh } from '../lib/mesh';
import { generateGcode } from '../lib/slicer/gcode';
import { planPrint, prepareMesh } from '../lib/slicer/plan';
import { resolveSettings, type PrintSettings } from '../lib/slicer/settings';
import { unitsToMm } from '../lib/slicer/geometry';
import { PATH_KINDS, type PreviewData, type SliceStats } from '../lib/slicer';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

export interface SliceRequest {
  id: number;
  positions: ArrayBuffer;
  indices: ArrayBuffer;
  settings: PrintSettings;
}

export type SliceResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'sliced'; gcode: string; stats: SliceStats; preview: PreviewData };

ctx.onmessage = (event: MessageEvent<SliceRequest>) => {
  const req = event.data;
  try {
    const mesh: Mesh = {
      positions: new Float32Array(req.positions),
      indices: new Uint32Array(req.indices),
    };
    const settings = resolveSettings(req.settings);
    const post = (fraction: number, label: string) =>
      ctx.postMessage({ id: req.id, type: 'progress', fraction, label } satisfies SliceResponse);

    const prepared = prepareMesh(mesh, settings.scalePercent);
    const { layers, openContours } = planPrint(prepared, settings, post);
    if (layers.length === 0) {
      ctx.postMessage({ id: req.id, type: 'error', message: 'The model produced no layers. Is it flat?' });
      return;
    }

    const result = generateGcode(layers, settings, post);

    // Pack the tool paths into typed arrays for the preview, already converted
    // to bed coordinates so the viewer needs no knowledge of the machine.
    const offsetX = settings.machine.origin === 'center' ? 0 : settings.machine.bed.x / 2;
    const offsetY = settings.machine.origin === 'center' ? 0 : settings.machine.bed.y / 2;

    let pathCount = 0;
    let pointCount = 0;
    for (const layer of layers) {
      for (const path of layer.paths) {
        pathCount++;
        pointCount += path.points.length + (path.closed ? 1 : 0);
      }
    }

    const preview: PreviewData = {
      printZ: new Float32Array(layers.length),
      layerStart: new Uint32Array(layers.length + 1),
      pathStart: new Uint32Array(pathCount + 1),
      pathKind: new Uint8Array(pathCount),
      points: new Float32Array(pointCount * 2),
    };

    let pi = 0;
    let vi = 0;
    layers.forEach((layer, li) => {
      preview.printZ[li] = layer.printZ;
      preview.layerStart[li] = pi;
      for (const path of layer.paths) {
        preview.pathStart[pi] = vi / 2;
        preview.pathKind[pi] = Math.max(0, PATH_KINDS.indexOf(path.kind));
        for (const point of path.points) {
          preview.points[vi++] = unitsToMm(point.X) + offsetX;
          preview.points[vi++] = unitsToMm(point.Y) + offsetY;
        }
        if (path.closed && path.points.length > 0) {
          preview.points[vi++] = unitsToMm(path.points[0].X) + offsetX;
          preview.points[vi++] = unitsToMm(path.points[0].Y) + offsetY;
        }
        pi++;
      }
    });
    preview.layerStart[layers.length] = pi;
    preview.pathStart[pathCount] = vi / 2;

    const stats: SliceStats = {
      estimatedSeconds: result.estimatedSeconds,
      filamentMm: result.filamentMm,
      filamentGrams: result.filamentGrams,
      layerCount: result.layerCount,
      openContours,
      warnings: result.warnings,
      extent: result.extent,
    };

    ctx.postMessage(
      { id: req.id, type: 'sliced', gcode: result.gcode, stats, preview } satisfies SliceResponse,
      [
        preview.printZ.buffer,
        preview.layerStart.buffer,
        preview.pathStart.buffer,
        preview.pathKind.buffer,
        preview.points.buffer,
      ],
    );
  } catch (err) {
    ctx.postMessage({
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies SliceResponse);
  }
};
