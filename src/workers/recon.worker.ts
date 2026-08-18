/// <reference lib="webworker" />
import { segmentImage, signedDistanceTransform } from '../lib/segment';
import { carveVisualHull, type SilhouetteView } from '../lib/carve';
import { buildHeightfield } from '../lib/heightfield';
import type { WirePaint, WorkerRequest, WorkerResponse, ViewDiagnostic } from '../lib/workerTypes';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

/** Paint layers are stored at whatever resolution they were drawn at. */
function resamplePaint(paint: WirePaint | undefined, width: number, height: number): Uint8Array | undefined {
  if (!paint) return undefined;
  const src = new Uint8Array(paint.data);
  if (paint.width === width && paint.height === height) return src;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(paint.height - 1, Math.floor((y * paint.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(paint.width - 1, Math.floor((x * paint.width) / width));
      out[y * width + x] = src[sy * paint.width + sx];
    }
  }
  return out;
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'segment') {
      const pixels = new Uint8ClampedArray(req.image.data);
      const result = segmentImage(pixels, req.image.width, req.image.height, {
        ...req.options,
        paint: resamplePaint(req.paint, req.image.width, req.image.height),
      });
      const buf = result.mask.buffer as ArrayBuffer;
      post(
        {
          id: req.id,
          type: 'segment',
          mask: buf,
          width: result.width,
          height: result.height,
          coverage: result.coverage,
          usedThreshold: result.usedThreshold,
          bbox: result.bbox,
        },
        [buf],
      );
      return;
    }

    if (req.type === 'reconstruct') {
      const total = req.views.length;
      const pixelsFor = req.views.map((v) => new Uint8ClampedArray(v.data));
      const paintFor = req.views.map((v) => resamplePaint(v.paint, v.width, v.height));

      // Pass one: segment every photo and let each pick its own strategy.
      const first = req.views.map((v, i) => {
        post({ id: req.id, type: 'progress', fraction: (i / total) * 0.3, label: `Finding outline ${i + 1}/${total}` });
        return segmentImage(pixelsFor[i], v.width, v.height, { ...v.options, paint: paintFor[i] });
      });

      /*
       * The photos in a set are the same scene from different sides, so they
       * should be read the same way. Letting each choose independently is what
       * produces the nastiest failure: half the outlines include the contact
       * shadow and half do not, the two halves disagree about how tall the
       * object is, and the carve splits the difference by eating the base.
       * So add up how well each strategy did across the whole set and re-run
       * the photos that went their own way.
       */
      const tally: Record<string, number> = {};
      for (const seg of first) {
        for (const [key, quality] of Object.entries(seg.strategyScores)) {
          tally[key] = (tally[key] ?? 0) + quality;
        }
      }
      const agreed = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];

      const segments = first.map((seg, i) => {
        if (!agreed || seg.strategy === agreed) return seg;
        const v = req.views[i];
        return segmentImage(pixelsFor[i], v.width, v.height, {
          ...v.options,
          paint: paintFor[i],
          forceStrategy: agreed,
        });
      });

      const views: SilhouetteView[] = [];
      const diagnostics: ViewDiagnostic[] = [];
      segments.forEach((seg, i) => {
        const v = req.views[i];
        diagnostics.push({
          angleDeg: v.angleDeg,
          coverage: seg.coverage,
          hasSilhouette: !!seg.bbox && seg.coverage > 0.002,
          heightRatio: 1,
        });
        if (!seg.bbox || seg.coverage <= 0.002) return;
        views.push({
          sdt: signedDistanceTransform(seg.mask, seg.width, seg.height),
          width: seg.width,
          height: seg.height,
          bbox: seg.bbox,
          angleDeg: v.angleDeg,
        });
      });

      if (views.length === 0) {
        post({
          id: req.id,
          type: 'error',
          message: 'No silhouette could be found in any photo. Try a plainer background, or paint the outline by hand.',
        });
        return;
      }

      const { mesh, heightRatios } = carveVisualHull(views, {
        ...req.carve,
        onProgress: (fraction, label) =>
          post({ id: req.id, type: 'progress', fraction: 0.4 + fraction * 0.6, label }),
      });

      // heightRatios only covers the views that produced a silhouette; walk the
      // diagnostics in the same order to line them back up.
      let carved = 0;
      for (const d of diagnostics) {
        if (d.hasSilhouette) d.heightRatio = heightRatios[carved++] ?? 1;
      }

      const pos = mesh.positions.buffer as ArrayBuffer;
      const idx = mesh.indices.buffer as ArrayBuffer;
      post({ id: req.id, type: 'mesh', positions: pos, indices: idx, diagnostics }, [pos, idx]);
      return;
    }

    if (req.type === 'heightfield') {
      post({ id: req.id, type: 'progress', fraction: 0.2, label: 'Reading photo' });
      const pixels = new Uint8ClampedArray(req.image.data);
      let mask: Uint8Array | undefined;
      let coverage = 1;
      if (req.useMask) {
        const seg = segmentImage(pixels, req.image.width, req.image.height, {
          ...req.segment,
          paint: resamplePaint(req.paint, req.image.width, req.image.height),
        });
        mask = seg.mask;
        coverage = seg.coverage;
      }
      post({ id: req.id, type: 'progress', fraction: 0.5, label: 'Building surface' });
      const { mesh } = buildHeightfield(pixels, req.image.width, req.image.height, {
        ...req.options,
        mask,
      });
      const pos = mesh.positions.buffer as ArrayBuffer;
      const idx = mesh.indices.buffer as ArrayBuffer;
      post(
        {
          id: req.id,
          type: 'mesh',
          positions: pos,
          indices: idx,
          diagnostics: [{ angleDeg: 0, coverage, hasSilhouette: !req.useMask || coverage > 0.002, heightRatio: 1 }],
        },
        [pos, idx],
      );
      return;
    }
  } catch (err) {
    post({ id: (req as { id: number }).id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
