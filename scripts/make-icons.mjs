/** Generates the PWA icons as real PNGs, with no image dependencies. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = maskable ? size * 0.18 : size * 0.06;
  const radius = maskable ? size * 0.5 : size * 0.22;
  const cx = size / 2;
  const cy = size / 2;

  // Isometric cube, drawn as a hexagon outline plus the three inner edges.
  const r = (size - pad * 2) * (maskable ? 0.3 : 0.31);
  const pt = (angleDeg) => [cx + r * Math.cos((angleDeg * Math.PI) / 180), cy + r * Math.sin((angleDeg * Math.PI) / 180)];
  const hex = [pt(-90), pt(-30), pt(30), pt(90), pt(150), pt(210)];
  const centre = [cx, cy];
  const edges = [];
  for (let i = 0; i < 6; i++) edges.push([hex[i], hex[(i + 1) % 6]]);
  edges.push([hex[0], centre], [hex[2], centre], [hex[4], centre]);
  const stroke = size * 0.045;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Rounded-square plate.
      const qx = Math.max(Math.abs(px - cx) - (size / 2 - pad - radius), 0);
      const qy = Math.max(Math.abs(py - cy) - (size / 2 - pad - radius), 0);
      const plate = Math.hypot(qx, qy) - radius;
      const plateAlpha = Math.max(0, Math.min(1, 0.5 - plate));
      if (plateAlpha <= 0) continue;

      const t = (px + py) / (size * 2);
      let r0 = 11 + t * 20;
      let g0 = 16 + t * 34;
      let b0 = 32 + t * 60;

      let best = Infinity;
      for (const [a, b] of edges) best = Math.min(best, distanceToSegment(px, py, a[0], a[1], b[0], b[1]));
      const line = Math.max(0, Math.min(1, stroke / 2 + 0.75 - best));
      if (line > 0) {
        // Cyan edges warming to amber towards the base, like a lit filament.
        const warm = Math.max(0, Math.min(1, (py - cy) / r));
        r0 = r0 * (1 - line) + (56 + warm * 190) * line;
        g0 = g0 * (1 - line) + (211 - warm * 20) * line;
        b0 = b0 * (1 - line) + (248 - warm * 190) * line;
      }

      rgba[i] = Math.round(r0);
      rgba[i + 1] = Math.round(g0);
      rgba[i + 2] = Math.round(b0);
      rgba[i + 3] = Math.round(plateAlpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon-192.png'), drawIcon(192, false));
writeFileSync(join(OUT_DIR, 'icon-512.png'), drawIcon(512, false));
writeFileSync(join(OUT_DIR, 'icon-maskable-512.png'), drawIcon(512, true));
console.log('icons written to', OUT_DIR);
