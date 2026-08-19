/**
 * Renders the synthetic turntable scene, carves it and writes the STL, so the
 * slicer can be exercised on a realistic scanned mesh.
 *
 *   node scripts/make-test-stl.mjs [out.stl]
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-photos/figure.stl';
const dir = mkdtempSync(join(tmpdir(), 'stl-'));
const entry = join(dir, 'entry.mjs');
writeFileSync(
  entry,
  `
import { renderScene, W, H } from '${join(process.cwd(), 'scripts/scene.mjs')}';
import { segmentImage, signedDistanceTransform } from '${join(process.cwd(), 'src/lib/segment.ts')}';
import { carveVisualHull } from '${join(process.cwd(), 'src/lib/carve.ts')}';
import { fitToPrintVolume, yUpToZUp } from '${join(process.cwd(), 'src/lib/mesh.ts')}';
import { meshToBinarySTL } from '${join(process.cwd(), 'src/lib/stl.ts')}';
import { writeFileSync } from 'node:fs';

const N = 16;
const scenes = Array.from({ length: N }, (_, i) => renderScene((360 / N) * i));
const first = scenes.map((s) => segmentImage(new Uint8ClampedArray(s.rgba), W, H));
const tally = {};
for (const seg of first) for (const [k, q] of Object.entries(seg.strategyScores)) tally[k] = (tally[k] ?? 0) + q;
const agreed = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
const views = first.map((seg, i) => {
  const final = seg.strategy === agreed ? seg : segmentImage(new Uint8ClampedArray(scenes[i].rgba), W, H, { forceStrategy: agreed });
  return { sdt: signedDistanceTransform(final.mask, W, H), width: W, height: H, bbox: final.bbox, angleDeg: (360 / N) * i };
});
const { mesh } = carveVisualHull(views, { resolution: 160, smoothIterations: 3 });
const printable = yUpToZUp(fitToPrintVolume(mesh, 60));
writeFileSync(process.argv[2], Buffer.from(meshToBinarySTL(printable, 'test figure')));
console.log('wrote', process.argv[2], (mesh.indices.length / 3).toLocaleString(), 'triangles');
`,
);
execSync(
  `npx esbuild ${entry} --bundle --format=esm --platform=node --outfile=${join(dir, 'b.mjs')} --log-level=warning && node ${join(dir, 'b.mjs')} ${out}`,
  { stdio: 'inherit' },
);
