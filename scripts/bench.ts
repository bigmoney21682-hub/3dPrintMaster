// @ts-nocheck
import { renderScene, W, H } from './scene.mjs';
import { segmentImage, signedDistanceTransform } from '../src/lib/segment';
import { carveVisualHull } from '../src/lib/carve';

const N = 16;
const scenes = [];
for (let i = 0; i < N; i++) scenes.push(renderScene((360 / N) * i));

let t0 = Date.now();
const views = [];
for (let i = 0; i < N; i++) {
  const seg = segmentImage(new Uint8ClampedArray(scenes[i].rgba), W, H);
  views.push({ sdt: signedDistanceTransform(seg.mask, W, H), width: W, height: H, bbox: seg.bbox, angleDeg: (360 / N) * i });
}
const segMs = Date.now() - t0;

for (const res of [96, 128, 160, 200]) {
  t0 = Date.now();
  const { mesh } = carveVisualHull(views, { resolution: res, smoothIterations: 3 });
  console.log(`  carve @${res}: ${Date.now() - t0} ms, ${(mesh.indices.length / 3).toLocaleString()} triangles`);
}
console.log(`segmentation of ${N} photos at ${W}x${H}: ${segMs} ms (${(segMs / N).toFixed(0)} ms each)`);

// Slice a realistic carved model: the same figure, at print size.
import { fitToPrintVolume, yUpToZUp, triangleCount } from '../src/lib/mesh';
import { planPrint, prepareMesh } from '../src/lib/slicer/plan';
import { generateGcode, formatDuration } from '../src/lib/slicer/gcode';
import { DEFAULT_SETTINGS, resolveSettings } from '../src/lib/slicer/settings';

const carved = carveVisualHull(views, { resolution: 160, smoothIterations: 3 }).mesh;
const printable = yUpToZUp(fitToPrintVolume(carved, 60));
console.log(`\nslicing a ${triangleCount(printable).toLocaleString()}-triangle carved model at 60 mm tall:`);
for (const layerHeight of [0.3, 0.2, 0.12]) {
  const settings = resolveSettings({ ...DEFAULT_SETTINGS, layerHeight, infillDensity: 15 });
  t0 = Date.now();
  const plan = planPrint(prepareMesh(printable, 100), settings);
  const planMs = Date.now() - t0;
  t0 = Date.now();
  const g = generateGcode(plan.layers, settings);
  const gcodeMs = Date.now() - t0;
  console.log(
    `  ${layerHeight} mm: plan ${planMs} ms + gcode ${gcodeMs} ms, ${plan.layers.length} layers, ` +
      `${(g.gcode.length / 1048576).toFixed(1)} MB, ${formatDuration(g.estimatedSeconds)} print, ${g.filamentGrams.toFixed(1)} g`,
  );
}
