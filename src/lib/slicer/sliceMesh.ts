import type { Mesh } from '../mesh';
import { meshBounds } from '../mesh';
import { clean, mmToUnits, union, type Path, type Paths } from './geometry';

/**
 * Slice a triangle mesh into closed contours, one set per layer.
 *
 * Two details do most of the work here:
 *
 *  - Edge intersections are always interpolated from the lexicographically
 *    smaller vertex, so two triangles sharing an edge produce bit-identical
 *    points. Contours then stitch together by exact integer match instead of
 *    needing a fuzzy tolerance that leaks holes.
 *  - Each segment is oriented with solid material on its left using the
 *    triangle's outward normal, so outer contours come out counter-clockwise
 *    and holes clockwise. Clipper's non-zero winding rule then handles nested
 *    shapes for free.
 */

export interface LayerContours {
  /** Height of the top of this layer above the bed, mm. */
  printZ: number;
  /** Height the geometry was sampled at, mm. */
  sliceZ: number;
  paths: Paths;
}

export interface SliceOptions {
  layerHeight: number;
  firstLayerHeight: number;
  onProgress?: (fraction: number) => void;
}

export interface SliceResult {
  layers: LayerContours[];
  /** Contours that could not be closed; a healthy mesh produces none. */
  openContours: number;
}

interface Segment {
  a: Point3;
  b: Point3;
}

interface Point3 {
  x: number;
  y: number;
}

const KEY_SHIFT = 4_194_304; // keeps keys positive for coordinates up to ±4.1 m

function key(x: number, y: number): number {
  return (x + KEY_SHIFT) * 8_388_608 + (y + KEY_SHIFT);
}

export function sliceMesh(mesh: Mesh, options: SliceOptions): SliceResult {
  const { layerHeight, firstLayerHeight } = options;
  const bounds = meshBounds(mesh);
  const minZ = bounds.min[2];
  const maxZ = bounds.max[2];
  const height = maxZ - minZ;
  if (height <= 0) return { layers: [], openContours: 0 };

  const layerCount = Math.max(1, Math.ceil((height - firstLayerHeight) / layerHeight) + 1);
  const printZs: number[] = [];
  const sliceZs: number[] = [];
  for (let i = 0; i < layerCount; i++) {
    const printZ = i === 0 ? firstLayerHeight : firstLayerHeight + i * layerHeight;
    if (minZ + printZ - layerHeight > maxZ) break;
    printZs.push(printZ);
    // Sample the middle of the layer: the truest cross-section of the slab
    // that layer represents.
    sliceZs.push(minZ + printZ - (i === 0 ? firstLayerHeight : layerHeight) / 2);
  }

  const buckets: Segment[][] = printZs.map(() => []);
  const p = mesh.positions;
  const ix = mesh.indices;
  const layerOf = (z: number) => {
    // sliceZs is ascending and evenly spaced after the first layer.
    let lo = 0;
    let hi = sliceZs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sliceZs[mid] < z) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (let t = 0; t < ix.length; t += 3) {
    const ia = ix[t] * 3;
    const ib = ix[t + 1] * 3;
    const ic = ix[t + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
    const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];

    const triMin = Math.min(az, bz, cz);
    const triMax = Math.max(az, bz, cz);
    if (triMax - triMin === 0) continue; // horizontal face contributes no contour

    // Outward normal, projected onto the slice plane.
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);

    const first = layerOf(triMin);
    for (let li = first; li < sliceZs.length; li++) {
      const z = sliceZs[li];
      if (z > triMax) break;
      if (z < triMin) continue;
      const seg = intersectTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, z, nx, ny);
      if (seg) buckets[li].push(seg);
    }
    if (options.onProgress && (t / 3) % 20000 === 0) {
      options.onProgress((t / ix.length) * 0.8);
    }
  }

  let openContours = 0;
  const layers: LayerContours[] = [];
  for (let li = 0; li < printZs.length; li++) {
    const { loops, open } = stitch(buckets[li]);
    openContours += open;
    const paths = clean(union(loops));
    layers.push({ printZ: printZs[li], sliceZ: sliceZs[li], paths });
    options.onProgress?.(0.8 + (li / printZs.length) * 0.2);
  }

  return { layers, openContours };
}

/** Interpolate an edge crossing, always from the lower-ordered vertex. */
function edgePoint(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  z: number,
): Point3 {
  const swap = z1 > z2 || (z1 === z2 && (x1 > x2 || (x1 === x2 && y1 > y2)));
  const [ax, ay, az, bx, by, bz] = swap ? [x2, y2, z2, x1, y1, z1] : [x1, y1, z1, x2, y2, z2];
  const t = az === bz ? 0 : (z - az) / (bz - az);
  return { x: mmToUnits(ax + (bx - ax) * t), y: mmToUnits(ay + (by - ay) * t) };
}

function intersectTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  z: number,
  nx: number, ny: number,
): Segment | null {
  const points: Point3[] = [];
  const edge = (
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ) => {
    // Treat "on the plane" as below it, so a vertex exactly at z is counted
    // once rather than producing a duplicate or a zero-length segment.
    const above1 = z1 > z;
    const above2 = z2 > z;
    if (above1 !== above2) points.push(edgePoint(x1, y1, z1, x2, y2, z2, z));
  };
  edge(ax, ay, az, bx, by, bz);
  edge(bx, by, bz, cx, cy, cz);
  edge(cx, cy, cz, ax, ay, az);
  if (points.length !== 2) return null;

  let [a, b] = points;
  if (a.x === b.x && a.y === b.y) return null;

  // Keep solid on the left: the outward normal must lie to the right.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dy * nx - dx * ny < 0) [a, b] = [b, a];
  return { a, b };
}

/** Chain segments end-to-start into closed loops. */
function stitch(segments: Segment[]): { loops: Paths; open: number } {
  const starts = new Map<number, number[]>();
  segments.forEach((seg, i) => {
    const k = key(seg.a.x, seg.a.y);
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  });

  const used = new Uint8Array(segments.length);
  const loops: Paths = [];
  let open = 0;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    const loop: Path = [];
    let current = i;
    let closed = false;
    let guard = 0;
    while (current >= 0 && guard++ < segments.length + 2) {
      used[current] = 1;
      const seg = segments[current];
      loop.push({ X: seg.a.x, Y: seg.a.y });
      const candidates = starts.get(key(seg.b.x, seg.b.y));
      const next = candidates?.find((j) => !used[j]);
      if (next === undefined) {
        // Ran out of segments: closed if we arrived back where we started.
        closed = candidates !== undefined && candidates.includes(i);
        break;
      }
      current = next;
    }
    if (loop.length < 3) {
      open++;
      continue;
    }
    if (!closed) open++;
    // Even an unclosed chain is worth keeping — the union treats it as if the
    // ends were joined, which is the best guess for a slightly broken mesh.
    loops.push(loop);
  }
  return { loops, open };
}
