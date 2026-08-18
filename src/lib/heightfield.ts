import type { Mesh } from './mesh';

/**
 * Single-photo modes. One photo can never describe a real 3D object, but it is
 * plenty for a relief, a lithophane, or a flat cut-out — all of which print
 * beautifully and are what people usually want from one picture.
 */
export type HeightfieldMode = 'relief' | 'lithophane' | 'stamp';

export interface HeightfieldOptions {
  mode: HeightfieldMode;
  /** Longest edge of the finished plate, mm. */
  sizeMm: number;
  /** Flat backing plate thickness, mm. */
  baseMm: number;
  /** Peak relief height above the base, mm. */
  reliefMm: number;
  /** Blur radius in samples; tames photo noise into printable shapes. */
  smooth: number;
  invert: boolean;
  /** Grid samples along the longest edge. */
  resolution: number;
  /** Optional silhouette; outside it the plate is cut away (relief/stamp). */
  mask?: Uint8Array;
}

export const DEFAULT_HEIGHTFIELD_OPTIONS: HeightfieldOptions = {
  mode: 'relief',
  sizeMm: 80,
  baseMm: 2,
  reliefMm: 6,
  smooth: 2,
  invert: false,
  resolution: 220,
};

export interface HeightfieldResult {
  mesh: Mesh;
  widthSamples: number;
  heightSamples: number;
}

function luminanceGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  outW: number,
  outH: number,
): Float32Array {
  const out = new Float32Array(outW * outH);
  // Box-average downsample: cheaper than a proper filter and it is exactly the
  // low-pass we want before turning pixels into geometry.
  for (let y = 0; y < outH; y++) {
    const sy0 = Math.floor((y * height) / outH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor((x * width) / outW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / outW));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          n++;
        }
      }
      out[y * outW + x] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

function resampleMask(mask: Uint8Array, width: number, height: number, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy0 = Math.floor((y * height) / outH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor((x * width) / outW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / outW));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += mask[sy * width + sx] ? 1 : 0;
          n++;
        }
      }
      out[y * outW + x] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const r = Math.round(radius);
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w) continue;
        sum += src[y * w + xx];
        n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h) continue;
        sum += tmp[yy * w + x];
        n++;
      }
      dst[y * w + x] = sum / n;
    }
  }
  return dst;
}

/**
 * Build a closed, watertight plate: a displaced top surface, a flat bottom and
 * vertical side walls. Coordinates are millimetres, Y up.
 */
export function buildHeightfield(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: Partial<HeightfieldOptions> = {},
): HeightfieldResult {
  const opts = { ...DEFAULT_HEIGHTFIELD_OPTIONS, ...options };
  const aspect = width / height;
  const res = Math.max(24, Math.round(opts.resolution));
  const W = aspect >= 1 ? res : Math.max(24, Math.round(res * aspect));
  const H = aspect >= 1 ? Math.max(24, Math.round(res / aspect)) : res;

  let lum = luminanceGrid(data, width, height, W, H);
  lum = boxBlur(lum, W, H, opts.smooth);

  const maskGrid = opts.mask ? resampleMask(opts.mask, width, height, W, H) : null;

  const heights = new Float32Array(W * H);
  for (let i = 0; i < heights.length; i++) {
    let v = lum[i];
    if (opts.invert) v = 1 - v;
    let h: number;
    if (opts.mode === 'lithophane') {
      // Thick where the photo is dark, so backlight shows the image.
      h = (1 - v) * opts.reliefMm;
    } else if (opts.mode === 'stamp') {
      h = opts.reliefMm;
    } else {
      h = v * opts.reliefMm;
    }
    if (maskGrid && opts.mode !== 'lithophane') h *= maskGrid[i] > 0.5 ? 1 : 0;
    heights[i] = opts.baseMm + h;
  }

  const cell = opts.sizeMm / Math.max(W - 1, H - 1);
  const originX = -((W - 1) * cell) / 2;
  const originZ = -((H - 1) * cell) / 2;

  const vertCount = W * H * 2;
  const positions = new Float32Array(vertCount * 3);
  const top = (x: number, y: number) => y * W + x;
  const bottom = (x: number, y: number) => W * H + y * W + x;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = originX + x * cell;
      const wz = originZ + y * cell;
      const t = top(x, y) * 3;
      positions[t] = wx;
      positions[t + 1] = heights[y * W + x];
      positions[t + 2] = wz;
      const b = bottom(x, y) * 3;
      positions[b] = wx;
      positions[b + 1] = 0;
      positions[b + 2] = wz;
    }
  }

  const tris: number[] = [];
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = top(x, y);
      const b = top(x + 1, y);
      const c = top(x + 1, y + 1);
      const d = top(x, y + 1);
      tris.push(a, d, c, a, c, b);
      const a2 = bottom(x, y);
      const b2 = bottom(x + 1, y);
      const c2 = bottom(x + 1, y + 1);
      const d2 = bottom(x, y + 1);
      tris.push(a2, b2, c2, a2, c2, d2);
    }
  }
  // Side walls, walking the perimeter so the solid is closed.
  for (let x = 0; x < W - 1; x++) {
    tris.push(top(x, 0), top(x + 1, 0), bottom(x + 1, 0));
    tris.push(top(x, 0), bottom(x + 1, 0), bottom(x, 0));
    tris.push(top(x + 1, H - 1), top(x, H - 1), bottom(x, H - 1));
    tris.push(top(x + 1, H - 1), bottom(x, H - 1), bottom(x + 1, H - 1));
  }
  for (let y = 0; y < H - 1; y++) {
    tris.push(top(0, y + 1), top(0, y), bottom(0, y));
    tris.push(top(0, y + 1), bottom(0, y), bottom(0, y + 1));
    tris.push(top(W - 1, y), top(W - 1, y + 1), bottom(W - 1, y + 1));
    tris.push(top(W - 1, y), bottom(W - 1, y + 1), bottom(W - 1, y));
  }

  return {
    mesh: { positions, indices: new Uint32Array(tris) },
    widthSamples: W,
    heightSamples: H,
  };
}
