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
