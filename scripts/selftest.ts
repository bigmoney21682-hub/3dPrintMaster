/**
 * Headless checks for the geometry pipeline: synthesise silhouettes of objects
 * whose true shape we know, carve them, and confirm the mesh matches.
 * Run with `npm run selftest`.
 */
import { carveVisualHull, defaultAngles, type SilhouetteView } from '../src/lib/carve';
import { signedDistanceTransform } from '../src/lib/segment';
import { surfaceNets } from '../src/lib/surfaceNets';
import { meshBounds, signedVolume, triangleCount, yUpToZUp, fitToPrintVolume, type Mesh } from '../src/lib/mesh';
import { meshToBinarySTL } from '../src/lib/stl';
import { buildHeightfield } from '../src/lib/heightfield';
import { segmentImage } from '../src/lib/segment';
import { renderScene, W as SCENE_W, H as SCENE_H } from './scene.mjs';
import { runSlicerChecks } from './slicer-tests';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function near(name: string, actual: number, expected: number, tol: number) {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ±${tol}`);
}

/** Every edge of a closed mesh must be shared by exactly two triangles. */
function watertight(mesh: Mesh): { ok: boolean; bad: number } {
  const counts = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const t = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [, n] of counts) if (n !== 2) bad++;
  return { ok: bad === 0, bad };
}

const IMG = 320;
const SCALE = 220; // pixels per world unit (object height is 1.0)
const CENTRE_X = IMG / 2;
const BOTTOM_Y = 285;

/** Render a silhouette for an object described by its half-width at angle t. */
function renderView(halfWidthAt: (theta: number) => number, angleDeg: number): SilhouetteView {
  const theta = (angleDeg * Math.PI) / 180;
  const halfWidth = halfWidthAt(theta);
  const mask = new Uint8Array(IMG * IMG);
  let x0 = IMG, y0 = IMG, x1 = -1, y1 = -1;
  for (let py = 0; py < IMG; py++) {
    const wy = (BOTTOM_Y - py) / SCALE;
    if (wy < 0 || wy > 1) continue;
    for (let px = 0; px < IMG; px++) {
      const u = (px - CENTRE_X) / SCALE;
      if (Math.abs(u) > halfWidth) continue;
      mask[py * IMG + px] = 255;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }
  return {
    sdt: signedDistanceTransform(mask, IMG, IMG),
    width: IMG,
    height: IMG,
    bbox: { x0, y0, x1, y1 },
    angleDeg,
  };
}

console.log('\nSurface nets on an analytic sphere');
{
  const n = 48;
  const field = new Float32Array(n * n * n);
  const radius = 0.35;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const wx = x / (n - 1) - 0.5;
        const wy = y / (n - 1) - 0.5;
        const wz = z / (n - 1) - 0.5;
        field[x + y * n + z * n * n] = radius - Math.hypot(wx, wy, wz);
      }
  const mesh = surfaceNets(field, {
    dims: [n, n, n],
    scale: [1 / (n - 1), 1 / (n - 1), 1 / (n - 1)],
    origin: [-0.5, -0.5, -0.5],
  });
  const b = meshBounds(mesh);
  near('sphere diameter x', b.max[0] - b.min[0], radius * 2, 0.03);
  near('sphere diameter y', b.max[1] - b.min[1], radius * 2, 0.03);
  const vol = signedVolume(mesh);
  near('sphere volume', vol, (4 / 3) * Math.PI * radius ** 3, 0.005);
  check('sphere normals point outward', vol > 0, `signed volume ${vol.toFixed(4)}`);
  const wt = watertight(mesh);
  check('sphere mesh watertight', wt.ok, `${wt.bad} unpaired edges`);
  console.log(`         ${triangleCount(mesh).toLocaleString()} triangles`);
}

console.log('\nCarving a cylinder (radius 0.30, height 1.00) from 16 views');
{
  const views = defaultAngles(16).map((a) => renderView(() => 0.3, a));
  const { mesh } = carveVisualHull(views, { resolution: 140, smoothIterations: 0 });
  const b = meshBounds(mesh);
  near('height', b.max[1] - b.min[1], 1, 0.03);
  near('base sits on y=0', b.min[1], 0, 0.02);
  near('width x', b.max[0] - b.min[0], 0.6, 0.03);
  near('width z', b.max[2] - b.min[2], 0.6, 0.03);
  // 16 tangent planes give a circumscribed 16-gon, slightly larger than the circle.
  near('volume', signedVolume(mesh), 16 * 0.3 ** 2 * Math.tan(Math.PI / 16) * 1, 0.02);
  const wt = watertight(mesh);
  check('watertight', wt.ok, `${wt.bad} unpaired edges`);
}

console.log('\nCarving a rectangular block (0.70 x 0.30 footprint) from 24 views');
{
  const a = 0.35;
  const bHalf = 0.15;
  const views = defaultAngles(24).map((deg) =>
    renderView((t) => a * Math.abs(Math.cos(t)) + bHalf * Math.abs(Math.sin(t)), deg),
  );
  const { mesh } = carveVisualHull(views, { resolution: 150, smoothIterations: 0 });
  const bb = meshBounds(mesh);
  near('width x', bb.max[0] - bb.min[0], 0.7, 0.03);
  near('depth z', bb.max[2] - bb.min[2], 0.3, 0.03);
  near('height', bb.max[1] - bb.min[1], 1, 0.03);
  near('x is centred', (bb.max[0] + bb.min[0]) / 2, 0, 0.02);
  near('z is centred', (bb.max[2] + bb.min[2]) / 2, 0, 0.02);
}

console.log('\nToo few views leaves visible facets (8 views of a cylinder)');
{
  const views8 = defaultAngles(8).map((a) => renderView(() => 0.3, a));
  const views32 = defaultAngles(32).map((a) => renderView(() => 0.3, a));
  const v8 = signedVolume(carveVisualHull(views8, { resolution: 120, smoothIterations: 0 }).mesh);
  const v32 = signedVolume(carveVisualHull(views32, { resolution: 120, smoothIterations: 0 }).mesh);
  const truth = Math.PI * 0.3 ** 2;
  check('8 views overshoot more than 32 views', v8 > v32, `8: ${v8.toFixed(4)}, 32: ${v32.toFixed(4)}, true: ${truth.toFixed(4)}`);
  check('both converge from above', v32 > truth * 0.98 && v8 < truth * 1.15);
}

console.log('\nExport pipeline');
{
  const views = defaultAngles(12).map((a) => renderView(() => 0.25, a));
  const { mesh } = carveVisualHull(views, { resolution: 100, smoothIterations: 2 });
  const sized = fitToPrintVolume(mesh, 60);
  const b = meshBounds(sized);
  near('longest edge scaled to 60mm', Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]), 60, 0.5);
  near('sits on the bed', b.min[1], 0, 0.001);

  const printable = yUpToZUp(sized);
  const pb = meshBounds(printable);
  near('Z-up: base at z=0', pb.min[2], 0, 0.001);
  near('Z-up: height preserved', pb.max[2] - pb.min[2], b.max[1] - b.min[1], 0.001);

  const stl = meshToBinarySTL(printable, 'selftest');
  const view = new DataView(stl);
  const tris = view.getUint32(80, true);
  check('STL header triangle count matches', tris === triangleCount(printable), `${tris} vs ${triangleCount(printable)}`);
  check('STL byte length correct', stl.byteLength === 84 + tris * 50, `${stl.byteLength} bytes`);
  const nx = view.getFloat32(84, true);
  const ny = view.getFloat32(88, true);
  const nz = view.getFloat32(92, true);
  near('first facet normal is unit length', Math.hypot(nx, ny, nz), 1, 1e-3);
}

console.log('\nRelief from a single photo');
{
  const w = 96;
  const h = 64;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x / (w - 1)) * 255);
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = 255;
    }
  const { mesh } = buildHeightfield(pixels, w, h, { sizeMm: 80, baseMm: 2, reliefMm: 6, smooth: 0, resolution: 80 });
  const b = meshBounds(mesh);
  near('plate width', b.max[0] - b.min[0], 80, 0.6);
  near('plate depth', b.max[2] - b.min[2], 80 * (h / w), 1.2);
  near('base at 0', b.min[1], 0, 1e-6);
  near('peak height', b.max[1], 8, 0.15);
  const wt = watertight(mesh);
  check('relief watertight', wt.ok, `${wt.bad} unpaired edges`);
  check('relief volume positive', signedVolume(mesh) > 0);
}

console.log('\nSegmenting a synthetic photo');
{
  // A warm-grey backdrop with a vignette and noise, and a green egg-shaped
  // object slightly off centre — roughly what a phone shot looks like.
  const w = 240;
  const h = 320;
  const pixels = new Uint8ClampedArray(w * h * 4);
  const cx = w * 0.52;
  const cy = h * 0.55;
  const rx = w * 0.22;
  const ry = h * 0.28;
  let trueArea = 0;
  const truth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const vignette = 1 - 0.18 * Math.hypot((x - w / 2) / w, (y - h / 2) / h) * 2;
      const noise = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      if (inside) {
        truth[y * w + x] = 255;
        trueArea++;
        pixels[i] = 46 + noise * 8;
        pixels[i + 1] = 138 + noise * 8;
        pixels[i + 2] = 74 + noise * 8;
      } else {
        pixels[i] = 214 * vignette + noise * 6;
        pixels[i + 1] = 209 * vignette + noise * 6;
        pixels[i + 2] = 198 * vignette + noise * 6;
      }
      pixels[i + 3] = 255;
    }
  }
  const seg = segmentImage(pixels, w, h);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < truth.length; i++) {
    const a = truth[i] > 0;
    const b = seg.mask[i] > 0;
    if (a && b) intersection++;
    if (a || b) union++;
  }
  const iou = union > 0 ? intersection / union : 0;
  check('silhouette overlaps the true shape', iou > 0.95, `IoU ${iou.toFixed(3)}`);
  near('coverage matches', seg.coverage, trueArea / (w * h), 0.01);
  check('bounding box found', !!seg.bbox);
  if (seg.bbox) {
    near('bbox width', seg.bbox.x1 - seg.bbox.x0, rx * 2, 4);
    near('bbox height', seg.bbox.y1 - seg.bbox.y0, ry * 2, 4);
  }
}

console.log('\nSegmenting hard cases');
{
  // Builds a scene: a coloured ellipse on a vignetted backdrop, optionally with
  // a soft contact shadow pooling under it.
  const build = (
    w: number,
    h: number,
    bg: [number, number, number],
    fg: [number, number, number],
    withShadow: boolean,
    grain = 0,
    opts: { low?: boolean; softEdge?: number } = {},
  ) => {
    const pixels = new Uint8ClampedArray(w * h * 4);
    const truth = new Uint8Array(w * h);
    const cx = w * 0.5;
    const cy = h * (opts.low ? 0.85 : 0.45);
    const rx = w * 0.24;
    const ry = h * 0.3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const radial = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
        const inside = radial <= 1;
        // Shallow depth of field: the object edge fades over several pixels
        // instead of stepping cleanly.
        const soft = opts.softEdge
          ? Math.max(0, Math.min(1, (1 + opts.softEdge / 100 - radial) / (2 * (opts.softEdge / 100))))
          : inside
            ? 1
            : 0;
        // Brighter in the middle, falling off towards the frame — the usual
        // result of a single light source over a table.
        const vig = 1 - 0.22 * Math.min(1, Math.hypot((x - w / 2) / (w / 2), (y - h / 2) / (h / 2)));
        const bgHere = bg.map((c) => c * vig) as [number, number, number];
        let [r, g, b] = opts.softEdge
          ? ([0, 1, 2].map((c) => fg[c] * soft + bgHere[c] * (1 - soft)) as [number, number, number])
          : inside
            ? fg
            : bgHere;
        if (soft < 0.5 && withShadow) {
          const belowness = (y - (cy + ry * 0.75)) / (h * 0.3);
          const shade = belowness > 0 ? Math.max(0, 1 - Math.abs(x - cx) / (rx * 2.1)) * Math.min(1, belowness * 3) : 0;
          const darken = 1 - 0.45 * shade;
          r *= darken;
          g *= darken;
          b *= darken;
        }
        if (grain > 0) {
          // Deterministic pseudo-noise plus a woven texture, so the backdrop is
          // not unrealistically flat.
          const n = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * grain;
          const weave = Math.sin(x * 0.9) * Math.cos(y * 1.1) * grain * 0.6;
          r += n + weave;
          g += n + weave;
          b += n * 0.8 + weave;
        }
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
        pixels[i + 3] = 255;
        if (inside) truth[y * w + x] = 255;
      }
    }
    return { pixels, truth, w, h };
  };

  const score = (scene: ReturnType<typeof build>) => {
    const seg = segmentImage(scene.pixels, scene.w, scene.h);
    let inter = 0;
    let union = 0;
    for (let i = 0; i < scene.truth.length; i++) {
      const a = scene.truth[i] > 0;
      const b = seg.mask[i] > 0;
      if (a && b) inter++;
      if (a || b) union++;
    }
    return { iou: union ? inter / union : 0, bbox: seg.bbox };
  };

  // Minimums differ because some scenes are genuinely ambiguous: with a soft
  // out-of-focus edge the "true" boundary is a several-pixel ramp, so any
  // answer inside the ramp is correct and scores around 0.85.
  const cases: Array<[string, ReturnType<typeof build>, number]> = [
    ['neutral dark object on white paper', build(200, 260, [242, 240, 235], [104, 102, 99], false), 0.9],
    ['same, with a contact shadow', build(200, 260, [242, 240, 235], [104, 102, 99], true), 0.9],
    ['pale object on a dark cloth', build(200, 260, [46, 48, 54], [214, 208, 190], true), 0.9],
    ['coloured object, strong shadow', build(200, 260, [228, 224, 214], [58, 120, 168], true), 0.9],
    ['noisy, textured backdrop', build(200, 260, [214, 206, 190], [96, 112, 92], true, 14), 0.9],
    ['low contrast on noisy cloth', build(200, 260, [150, 148, 143], [112, 116, 124], true, 10), 0.9],
    ['object running off the bottom of the frame', build(200, 260, [232, 228, 218], [70, 130, 96], false, 6, { low: true }), 0.9],
    ['soft out-of-focus edges', build(200, 260, [230, 226, 216], [92, 108, 150], false, 5, { softEdge: 9 }), 0.85],
  ];
  for (const [name, scene, minimum] of cases) {
    const { iou } = score(scene);
    check(name, iou > minimum, `IoU ${iou.toFixed(3)} (needs > ${minimum})`);
  }
}

console.log('\nEnd to end: 16 rendered photos of a figure on a turntable');
{
  const N = 16;
  const scenes = Array.from({ length: N }, (_, i) => renderScene((360 / N) * i));

  // Same set-wide agreement the worker applies: every photo of one object
  // should be read the same way.
  const first = scenes.map((s) => segmentImage(new Uint8ClampedArray(s.rgba), SCENE_W, SCENE_H));
  const tally: Record<string, number> = {};
  for (const seg of first) {
    for (const [k, q] of Object.entries(seg.strategyScores)) tally[k] = (tally[k] ?? 0) + q;
  }
  const agreed = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];

  let worstIou = 1;
  const heights = new Set<number>();
  const views = first.map((seg, i) => {
    const final =
      seg.strategy === agreed
        ? seg
        : segmentImage(new Uint8ClampedArray(scenes[i].rgba), SCENE_W, SCENE_H, { forceStrategy: agreed });
    let inter = 0;
    let union = 0;
    for (let j = 0; j < scenes[i].truth.length; j++) {
      const a = scenes[i].truth[j] > 0;
      const b = final.mask[j] > 0;
      if (a && b) inter++;
      if (a || b) union++;
    }
    worstIou = Math.min(worstIou, union ? inter / union : 0);
    heights.add(final.bbox!.y1 - final.bbox!.y0);
    return {
      sdt: signedDistanceTransform(final.mask, SCENE_W, SCENE_H),
      width: SCENE_W,
      height: SCENE_H,
      bbox: final.bbox!,
      angleDeg: (360 / N) * i,
    };
  });

  check('every photo yields an outline', views.length === N, `${views.length}/${N}`);
  check('outlines agree on the object height', heights.size <= 2, `${heights.size} distinct heights`);
  check('outlines match the rendered object', worstIou > 0.97, `worst IoU ${worstIou.toFixed(3)}`);

  const { mesh } = carveVisualHull(views, { resolution: 140, smoothIterations: 0 });
  const bb = meshBounds(mesh);
  near('model stands on the bed', bb.min[1], 0, 0.02);
  near('model height', bb.max[1] - bb.min[1], 1, 0.04);

  // The subject is a big sphere with a smaller head: widest around a third of
  // the way up, clearly narrower at the top.
  const widthAt = (frac: number) => {
    const target = bb.min[1] + (bb.max[1] - bb.min[1]) * frac;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i + 1] - target) < 0.012) {
        lo = Math.min(lo, mesh.positions[i]);
        hi = Math.max(hi, mesh.positions[i]);
      }
    }
    return hi - lo;
  };
  const belly = widthAt(0.35);
  const head = widthAt(0.95);
  near('widest point matches the body sphere', belly, 0.68, 0.06);
  check('the head is narrower than the body', head < belly * 0.6, `head ${head.toFixed(3)} vs body ${belly.toFixed(3)}`);
  check('model is the right way up', widthAt(0.2) > widthAt(0.8), 'wider low than high');
}

runSlicerChecks(check, near);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
