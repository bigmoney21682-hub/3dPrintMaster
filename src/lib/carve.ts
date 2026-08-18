import type { Mesh } from './mesh';
import { smoothMesh } from './mesh';
import { surfaceNets } from './surfaceNets';

/**
 * Visual-hull reconstruction ("space carving").
 *
 * Each photo contributes a silhouette; a voxel survives only if it projects
 * inside the silhouette of (nearly) every view. Because we carve with a signed
 * distance field rather than a binary in/out test, the extracted isosurface
 * lands between voxels and comes out smooth.
 *
 * Camera model: orthographic, level or slightly tilted down, object rotating on
 * a turntable about the world Y axis. That is exactly the "spin it on a plate
 * and shoot every N degrees" workflow, and it needs no camera calibration.
 *
 * Known limit: a visual hull cannot see concavities. The inside of a mug comes
 * out solid. Convex-ish objects reconstruct well.
 */

export interface SilhouetteView {
  /** Signed distance to the silhouette edge, in pixels, positive inside. */
  sdt: Float32Array;
  width: number;
  height: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Turntable angle for this shot, degrees. */
  angleDeg: number;
}

export interface CarveOptions {
  /** Voxel samples along the longest axis. */
  resolution: number;
  /** Camera tilt below horizontal, degrees. 0 = shot at object height. */
  elevationDeg: number;
  /** How many views may disagree before a voxel is carved away. */
  tolerance: number;
  /**
   * 'consistent' derives one scale from the median silhouette height, which is
   * right for a turntable and stops a single bad outline from resizing the
   * model. 'per-view' trusts each photo's own height, which suits a handheld
   * walk-around where the distance drifted.
   */
  alignment: 'consistent' | 'per-view';
  /** Flatten everything below the turntable plane so the print has a base. */
  flatBase: boolean;
  smoothIterations: number;
  onProgress?: (fraction: number, label: string) => void;
}

export const DEFAULT_CARVE_OPTIONS: CarveOptions = {
  resolution: 160,
  elevationDeg: 0,
  tolerance: 0,
  alignment: 'consistent',
  flatBase: true,
  smoothIterations: 3,
};

export interface CarveResult {
  mesh: Mesh;
  /** World-space height of the object is 1.0; this is its half-width. */
  radius: number;
  dims: [number, number, number];
  voxelCount: number;
  /** Each view's silhouette height over the median; far from 1 means trouble. */
  heightRatios: number[];
}

interface ViewGeometry {
  cos: number;
  sin: number;
  scale: number; // pixels per world unit
  centerX: number;
  bottomY: number;
  vBase: number;
}

export function carveVisualHull(views: SilhouetteView[], options: Partial<CarveOptions> = {}): CarveResult {
  const opts = { ...DEFAULT_CARVE_OPTIONS, ...options };
  if (views.length === 0) throw new Error('No silhouettes to carve from.');

  const phi = (opts.elevationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const prepared = views.map((v) => {
    const theta = (v.angleDeg * Math.PI) / 180;
    return {
      view: v,
      cos: Math.cos(theta),
      sin: Math.sin(theta),
      hPix: v.bbox.y1 - v.bbox.y0 + 1,
      halfWPix: (v.bbox.x1 - v.bbox.x0 + 1) / 2,
      centerX: (v.bbox.x0 + v.bbox.x1) / 2,
      bottomY: v.bbox.y1,
      spread: Math.abs(Math.sin(theta)) + Math.abs(Math.cos(theta)),
    };
  });

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const medianHeight = median(prepared.map((p) => p.hPix)) || 1;
  const medianBottom = median(prepared.map((p) => p.bottomY));
  const heightRatios = prepared.map((p) => p.hPix / medianHeight);

  // Scale and footprint solve together (the tilt correction depends on the
  // footprint), so iterate a few times from a sensible seed.
  let radius = 0.5;
  const geo: ViewGeometry[] = [];
  for (let iter = 0; iter < 5; iter++) {
    geo.length = 0;
    let maxHalfWidth = 0;
    for (const p of prepared) {
      const depth = radius * p.spread;
      const vSpan = cosPhi + 2 * depth * sinPhi;
      const heightPx = opts.alignment === 'consistent' ? medianHeight : p.hPix;
      const scale = heightPx / Math.max(vSpan, 1e-6);
      geo.push({
        cos: p.cos,
        sin: p.sin,
        scale,
        centerX: p.centerX,
        // Vertical framing barely moves between shots on a turntable, so one
        // agreed baseline beats trusting an outline that swallowed a shadow.
        bottomY: opts.alignment === 'consistent' ? medianBottom : p.bottomY,
        vBase: -depth * sinPhi,
      });
      maxHalfWidth = Math.max(maxHalfWidth, p.halfWPix / scale);
    }
    radius = Math.max(maxHalfWidth * 1.02, 0.02);
  }

  // World box: y in [0,1] is the object, x/z in [-radius, radius], plus padding
  // so the isosurface has room to close on every side.
  const extent = Math.max(2 * radius, 1);
  const voxel = extent / Math.max(8, opts.resolution - 1);
  const pad = 2 * voxel;
  const minX = -radius - pad;
  const minY = -pad;
  const minZ = -radius - pad;
  const nx = Math.max(4, Math.round((2 * radius + 2 * pad) / voxel) + 1);
  const ny = Math.max(4, Math.round((1 + 2 * pad) / voxel) + 1);
  const nz = nx;

  const field = new Float32Array(nx * ny * nz);
  const nViews = geo.length;
  const keep = Math.max(0, Math.min(opts.tolerance, nViews - 1));
  const best = new Float32Array(keep + 1);

  for (let zi = 0; zi < nz; zi++) {
    const wz = minZ + zi * voxel;
    if (opts.onProgress && zi % 8 === 0) opts.onProgress(zi / nz, 'Carving voxels');
    for (let yi = 0; yi < ny; yi++) {
      const wy = minY + yi * voxel;
      const rowBase = yi * nx + zi * nx * ny;
      for (let xi = 0; xi < nx; xi++) {
        const wx = minX + xi * voxel;

        best.fill(Infinity);
        for (let k = 0; k < nViews; k++) {
          const g = geo[k];
          const u = wx * g.cos - wz * g.sin;
          const zc = wx * g.sin + wz * g.cos;
          const v = wy * cosPhi - zc * sinPhi;
          const px = g.centerX + u * g.scale;
          const py = g.bottomY - (v - g.vBase) * g.scale;
          const d = sampleSdt(views[k], px, py) / g.scale;

          if (d < best[keep]) {
            let i = keep;
            while (i > 0 && best[i - 1] > d) {
              best[i] = best[i - 1];
              i--;
            }
            best[i] = d;
            // Once the k-th smallest is already outside, no later view can save
            // this voxel — but we still need every view's vote, so no early out.
          }
        }

        let value = best[keep];
        if (opts.flatBase && wy < value) value = wy;
        field[xi + rowBase] = value;
      }
    }
  }

  opts.onProgress?.(0.9, 'Building surface');
  let mesh = surfaceNets(field, {
    dims: [nx, ny, nz],
    scale: [voxel, voxel, voxel],
    origin: [minX, minY, minZ],
  });

  if (opts.smoothIterations > 0) {
    opts.onProgress?.(0.96, 'Smoothing');
    mesh = smoothMesh(mesh, opts.smoothIterations);
  }
  opts.onProgress?.(1, 'Done');

  return { mesh, radius, dims: [nx, ny, nz], voxelCount: nx * ny * nz, heightRatios };
}

/** Bilinear sample of a view's signed distance field, in pixels. */
function sampleSdt(view: SilhouetteView, px: number, py: number): number {
  const { sdt, width, height } = view;
  const cx = Math.min(width - 1.001, Math.max(0, px));
  const cy = Math.min(height - 1.001, Math.max(0, py));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const i = y0 * width + x0;
  const v =
    sdt[i] * (1 - fx) * (1 - fy) +
    sdt[i + 1] * fx * (1 - fy) +
    sdt[i + width] * (1 - fx) * fy +
    sdt[i + width + 1] * fx * fy;

  // Anything that projects off the edge of the frame is definitely not inside
  // the silhouette; fall off smoothly so the isosurface stays well behaved.
  const outX = Math.max(0, -px, px - (width - 1));
  const outY = Math.max(0, -py, py - (height - 1));
  const out = Math.hypot(outX, outY);
  return out > 0 ? Math.min(v, 0) - out : v;
}

/** Evenly spaced turntable angles for n shots over `sweepDeg` degrees. */
export function defaultAngles(n: number, sweepDeg = 360): number[] {
  if (n <= 1) return [0];
  const step = sweepDeg >= 360 ? 360 / n : sweepDeg / (n - 1);
  return Array.from({ length: n }, (_, i) => i * step);
}
