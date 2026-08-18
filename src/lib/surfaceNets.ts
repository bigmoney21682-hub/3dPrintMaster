import type { Mesh } from './mesh';
import { orientOutward } from './mesh';

/**
 * Naive Surface Nets isosurface extraction.
 *
 * Chosen over marching cubes because it needs no 256-entry triangle table (the
 * only lookup is derived programmatically below), always produces a manifold
 * watertight mesh, and gives noticeably smoother results on voxel data like a
 * carved visual hull.
 *
 * Convention: field > 0 is inside the object, field < 0 is outside. The surface
 * is the zero crossing.
 */

// The 8 cube corners, bit 0 = +x, bit 1 = +y, bit 2 = +z.
const CORNERS: Array<[number, number, number]> = [];
for (let i = 0; i < 8; i++) CORNERS.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);

// The 12 cube edges. Generated so edges 0,1,2 are corner-0 along +x, +y, +z,
// which the quad emission step below relies on.
const EDGES: Array<[number, number]> = [];
for (let a = 0; a < 8; a++) {
  for (const bit of [1, 2, 4]) {
    const b = a ^ bit;
    if (a < b) EDGES.push([a, b]);
  }
}

export interface SurfaceNetsOptions {
  dims: [number, number, number]; // number of samples along x, y, z
  /** World size of one voxel step. */
  scale: [number, number, number];
  /** World position of sample (0,0,0). */
  origin: [number, number, number];
}

export function surfaceNets(field: Float32Array, opts: SurfaceNetsOptions): Mesh {
  const [nx, ny, nz] = opts.dims;
  const [sx, sy, sz] = opts.scale;
  const [ox, oy, oz] = opts.origin;

  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  if (cx <= 0 || cy <= 0 || cz <= 0) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

  const vertexIndex = new Int32Array(cx * cy * cz).fill(-1);
  const positions: number[] = [];
  const g = new Float32Array(8);

  const rowStride = nx;
  const sliceStride = nx * ny;
  const cellRow = cx;
  const cellSlice = cx * cy;

  // Pass 1: one vertex per cell that straddles the surface, placed at the
  // average of the zero crossings on that cell's edges.
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const c = CORNERS[i];
          const v = field[(x + c[0]) + (y + c[1]) * rowStride + (z + c[2]) * sliceStride];
          g[i] = v;
          if (v < 0) mask |= 1 << i;
        }
        if (mask === 0 || mask === 255) continue;

        let px = 0, py = 0, pz = 0, crossings = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0];
          const b = EDGES[e][1];
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const ga = g[a];
          const gb = g[b];
          const denom = ga - gb;
          const t = Math.abs(denom) < 1e-12 ? 0.5 : ga / denom;
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          px += ca[0] + t * (cb[0] - ca[0]);
          py += ca[1] + t * (cb[1] - ca[1]);
          pz += ca[2] + t * (cb[2] - ca[2]);
          crossings++;
        }
        if (crossings === 0) continue;

        vertexIndex[x + y * cellRow + z * cellSlice] = positions.length / 3;
        positions.push(
          ox + (x + px / crossings) * sx,
          oy + (y + py / crossings) * sy,
          oz + (z + pz / crossings) * sz,
        );
      }
    }
  }

  // Pass 2: for every grid edge that crosses the surface, stitch the four
  // surrounding cell vertices into a quad.
  const indices: number[] = [];
  const cellStride = [1, cellRow, cellSlice];
  const pushQuad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };

  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        const m = x + y * cellRow + z * cellSlice;
        if (vertexIndex[m] < 0) continue;
        const base = field[x + y * rowStride + z * sliceStride];
        const baseNeg = base < 0;
        const coord = [x, y, z];

        for (let axis = 0; axis < 3; axis++) {
          const nx2 = x + (axis === 0 ? 1 : 0);
          const ny2 = y + (axis === 1 ? 1 : 0);
          const nz2 = z + (axis === 2 ? 1 : 0);
          const other = field[nx2 + ny2 * rowStride + nz2 * sliceStride];
          if (baseNeg === (other < 0)) continue;

          const iu = (axis + 1) % 3;
          const iv = (axis + 2) % 3;
          if (coord[iu] === 0 || coord[iv] === 0) continue;

          const du = cellStride[iu];
          const dv = cellStride[iv];
          const v0 = vertexIndex[m];
          const v1 = vertexIndex[m - du];
          const v2 = vertexIndex[m - du - dv];
          const v3 = vertexIndex[m - dv];
          if (v1 < 0 || v2 < 0 || v3 < 0) continue;

          if (baseNeg) pushQuad(v0, v1, v2, v3);
          else pushQuad(v0, v3, v2, v1);
        }
      }
    }
  }

  const mesh: Mesh = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
  return orientOutward(mesh);
}
