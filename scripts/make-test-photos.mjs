/**
 * Renders a synthetic "turntable shoot" so the whole app can be exercised
 * without a real object: an asymmetric figure on a plain backdrop, shot every
 * 360/N degrees with a level orthographic camera.
 *
 *   node scripts/make-test-photos.mjs [count] [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './png.mjs';
import { renderRgba, W, H } from './scene.mjs';

const COUNT = Number(process.argv[2] ?? 16);
const OUT = process.argv[3] ?? 'test-photos';

mkdirSync(OUT, { recursive: true });
for (let i = 0; i < COUNT; i++) {
  const angle = (360 / COUNT) * i;
  writeFileSync(join(OUT, `shot-${String(i).padStart(2, '0')}.png`), encodePng(W, H, renderRgba(angle)));
}
console.log(`wrote ${COUNT} test photos to ${OUT}/`);
