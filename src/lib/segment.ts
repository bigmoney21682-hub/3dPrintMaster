/**
 * Silhouette extraction. Everything downstream (the visual hull carve) is only
 * as good as these masks, so this module gets the most attention: a colour
 * model learned from the image border, morphological cleanup, largest-component
 * selection and hole filling, plus per-pixel manual overrides painted by hand.
 */

export interface SegmentOptions {
  /** 0..1. Higher keeps more of the image as foreground. */
  threshold: number;
  /** Pick the threshold automatically with Otsu instead of using `threshold`. */
  autoThreshold: boolean;
  /** Morphological cleanup radius in pixels. */
  cleanup: number;
  keepLargest: boolean;
  fillHoles: boolean;
  /** Extra background colours the user tapped, as sRGB triples 0..255. */
  bgSamples?: Array<[number, number, number]>;
  /** 0 = no override, 1 = force foreground, 2 = force background. */
  paint?: Uint8Array;
  /** Ignore everything outside this rect (x, y, w, h in pixels). */
  crop?: { x: number; y: number; w: number; h: number };
  /**
   * Force a particular background-detection strategy instead of letting this
   * photo choose. Used to keep a whole turntable set consistent.
   */
  forceStrategy?: string;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  threshold: 0.25,
  autoThreshold: true,
  cleanup: 2,
  keepLargest: true,
  fillHoles: true,
};

export interface SegmentResult {
  mask: Uint8Array; // 0 or 255
  width: number;
  height: number;
  coverage: number; // fraction of pixels that are foreground
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  usedThreshold: number;
  /** Which background-detection strategy won for this photo. */
  strategy: string;
  /** How decisively it split the photo; comparable across strategies. */
  strategyQuality: number;
  /** Quality of every strategy, for choosing one that suits a whole set. */
  strategyScores: Record<string, number>;
}

/**
 * The backdrop is modelled as a handful of colour clusters learned from the
 * frame border. Distance is measured in CIELAB with lightness weighted down,
 * because the single most common failure is a shadow — the same colour as the
 * table, just darker — being mistaken for part of the object.
 */
/**
 * How much a lightness difference should count when comparing two colours.
 *
 * - "tolerant" reads a drop in lightness as a shadow falling across the
 *   backdrop, so colour decides. This rescues scenes with a hard contact shadow
 *   pooling under the object.
 * - "literal" takes lightness at face value, which is the only thing that can
 *   separate a grey object sitting on white paper.
 *
 * Neither wins everywhere, so the photo is segmented under both and whichever
 * splits it more decisively is kept.
 */
interface LightnessModel {
  key: 'tolerant' | 'literal';
  darker: number;
  lighter: number;
}

const MODELS: LightnessModel[] = [
  { key: 'tolerant', darker: 0.18, lighter: 0.28 },
  { key: 'literal', darker: 0.85, lighter: 0.85 },
];
const CLUSTERS = 5;
const MIN_CLUSTER_SHARE = 0.06;

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labFinv(t: number): number {
  return t > 0.008856451679 ? Math.cbrt(t) : t / 0.1284185493 + 4 / 29;
}

/** sRGB (0..255) to CIELAB. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labFinv(x);
  const fy = labFinv(y);
  const fz = labFinv(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDistance2(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
  model: LightnessModel,
): number {
  const dl = (l1 - l2) * (l1 < l2 ? model.darker : model.lighter);
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

interface Cluster {
  l: number;
  a: number;
  b: number;
  sigma: number;
  share: number;
  /** How many of the four frame edges this colour shows up along. */
  sides: number;
}

function clusterBackground(
  samples: Float32Array,
  count: number,
  model: LightnessModel,
  sideOf: Uint8Array,
): Cluster[] {
  if (count === 0) return [{ l: 100, a: 0, b: 0, sigma: 8, share: 1, sides: 4 }];
  const k = Math.min(CLUSTERS, count);

  // Deterministic k-means++ style seeding: start at the mean, then repeatedly
  // take the sample furthest from everything chosen so far.
  const centres: number[][] = [];
  let ml = 0, ma = 0, mb = 0;
  for (let i = 0; i < count; i++) {
    ml += samples[i * 3];
    ma += samples[i * 3 + 1];
    mb += samples[i * 3 + 2];
  }
  centres.push([ml / count, ma / count, mb / count]);
  while (centres.length < k) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < count; i++) {
      let nearest = Infinity;
      for (const c of centres) {
        const d = labDistance2(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], c[0], c[1], c[2], model);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = i;
      }
    }
    centres.push([samples[bestIdx * 3], samples[bestIdx * 3 + 1], samples[bestIdx * 3 + 2]]);
  }

  const assign = new Int32Array(count);
  for (let iter = 0; iter < 10; iter++) {
    let moved = 0;
    for (let i = 0; i < count; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = labDistance2(
          samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2],
          centres[c][0], centres[c][1], centres[c][2],
          model,
        );
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < count; i++) {
      const s = sums[assign[i]];
      s[0] += samples[i * 3];
      s[1] += samples[i * 3 + 1];
      s[2] += samples[i * 3 + 2];
      s[3]++;
    }
    for (let c = 0; c < centres.length; c++) {
      if (sums[c][3] === 0) continue;
      centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (moved === 0) break;
  }

  const spread = centres.map(() => [0, 0]);
  for (let i = 0; i < count; i++) {
    const c = assign[i];
    spread[c][0] += labDistance2(
      samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2],
      centres[c][0], centres[c][1], centres[c][2],
      model,
    );
    spread[c][1]++;
  }

  // Which frame edges each colour appears along. The backdrop wraps around the
  // subject and shows up on most sides; an object that runs out of frame only
  // touches one or two.
  const sideTotals = [0, 0, 0, 0];
  const perCluster = centres.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < count; i++) {
    sideTotals[sideOf[i]]++;
    perCluster[assign[i]][sideOf[i]]++;
  }

  const clusters: Cluster[] = centres.map((c, i) => ({
    l: c[0],
    a: c[1],
    b: c[2],
    sigma: Math.min(16, Math.max(3.5, 2.2 * Math.sqrt(spread[i][1] > 0 ? spread[i][0] / spread[i][1] : 16))),
    share: spread[i][1] / count,
    sides: perCluster[i].filter((n, side) => sideTotals[side] > 0 && n / sideTotals[side] >= 0.15).length,
  }));

  // A cluster confined to one or two edges, or with barely any members, is the
  // subject intruding into the border strip rather than the backdrop.
  const kept = clusters.filter((c) => c.share >= MIN_CLUSTER_SHARE && c.sides >= 3);
  return kept.length > 0 ? kept : [clusters.reduce((a, b) => (a.share >= b.share ? a : b))];
}

function toLab(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const lab = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const [L, a, b] = rgbToLab(data[p], data[p + 1], data[p + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return lab;
}

/** Lab samples from a strip around the frame, where the backdrop lives. */
function borderSamples(
  lab: Float32Array,
  width: number,
  height: number,
): { samples: Float32Array; sides: Uint8Array } {
  const border = Math.max(2, Math.round(Math.min(width, height) * 0.05));
  const collected: number[] = [];
  const sides: number[] = [];
  const stride = Math.max(1, Math.round(Math.min(width, height) / 160));
  for (let y = 0; y < height; y += stride) {
    const edgeRow = y < border || y >= height - border;
    for (let x = 0; x < width; x += stride) {
      if (!edgeRow && x >= border && x < width - border) continue;
      const i = (y * width + x) * 3;
      collected.push(lab[i], lab[i + 1], lab[i + 2]);
      sides.push(y < border ? 0 : y >= height - border ? 1 : x < border ? 2 : 3);
    }
  }
  return { samples: Float32Array.from(collected), sides: Uint8Array.from(sides) };
}

/**
 * Background-likeness straight from the colour model, ignoring connectivity.
 * Complements the flood: when the object's edge is soft or low contrast the
 * flood leaks across it, and this global view is what catches the object.
 */
function scoreAgainstClusters(
  lab: Float32Array,
  pixelCount: number,
  clusters: Cluster[],
  model: LightnessModel,
): Float32Array {
  const score = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const L = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    let best = 0;
    for (const c of clusters) {
      const s = Math.exp(-labDistance2(L, a, b, c.l, c.a, c.b, model) / (c.sigma * c.sigma));
      if (s > best) best = s;
    }
    score[i] = best;
  }
  return score;
}

/** Per-pixel "how much does this look like the backdrop" score in 0..1. */
export function backgroundScoreMap(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bgSamples?: Array<[number, number, number]>,
): Float32Array {
  return chooseScoreMap(data, width, height, bgSamples, undefined).score;
}

const QUANT = 0.5; // Lab units per bucket
const MAX_STEP = 120;

/**
 * Background-likeness from border connectivity.
 *
 * Instead of asking "what colour is the backdrop", ask "can I walk here from
 * the edge of the frame without ever stepping over a colour cliff". The cost of
 * a path is its single worst step (a minimax or bottleneck path), so smooth
 * gradients — vignetting, a lamp on one side, a soft shadow — cost almost
 * nothing, while the hard edge around the object is expensive to cross.
 *
 * Solved with a bucket-queue Dijkstra variant, linear in the pixel count.
 */
function borderConnectedScore(
  lab: Float32Array,
  width: number,
  height: number,
  model: LightnessModel,
  clusters: Cluster[],
): Float32Array {
  const n = width * height;
  const dist = new Int32Array(n).fill(0x7fffffff);
  const buckets: number[][] = Array.from({ length: Math.ceil(MAX_STEP / QUANT) + 2 }, () => []);

  // Measure each step across a three-pixel baseline rather than between
  // touching pixels. Real photo edges are anti-aliased or slightly out of
  // focus, so an adjacent-pixel difference only sees half of the object's true
  // contrast and the flood walks straight through it.
  const stepCost = (x: number, y: number, dx: number, dy: number) => {
    const ax = Math.min(width - 1, Math.max(0, x - dx));
    const ay = Math.min(height - 1, Math.max(0, y - dy));
    const bx = Math.min(width - 1, Math.max(0, x + 2 * dx));
    const by = Math.min(height - 1, Math.max(0, y + 2 * dy));
    const a = (ay * width + ax) * 3;
    const b = (by * width + bx) * 3;
    const d = Math.sqrt(labDistance2(lab[a], lab[a + 1], lab[a + 2], lab[b], lab[b + 1], lab[b + 2], model));
    return Math.min(buckets.length - 1, Math.round(d / QUANT));
  };

  // Only start from frame pixels that actually look like the backdrop,
  // otherwise an object running out of frame seeds the flood inside itself and
  // the whole subject reads as background.
  const looksLikeBackdrop = (i: number) => {
    for (const c of clusters) {
      if (labDistance2(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], c.l, c.a, c.b, model) <= 6.25 * c.sigma * c.sigma) {
        return true;
      }
    }
    return false;
  };
  const candidateSeeds: number[] = [];
  for (let x = 0; x < width; x++) {
    candidateSeeds.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    candidateSeeds.push(y * width, y * width + width - 1);
  }
  let seeded = 0;
  for (const i of candidateSeeds) {
    if (dist[i] === 0 || !looksLikeBackdrop(i)) continue;
    dist[i] = 0;
    buckets[0].push(i);
    seeded++;
  }
  if (seeded === 0) {
    // Nothing on the frame matched the backdrop model; fall back to trusting
    // the whole border rather than returning an empty result.
    for (const i of candidateSeeds) {
      if (dist[i] === 0) continue;
      dist[i] = 0;
      buckets[0].push(i);
    }
  }

  for (let level = 0; level < buckets.length; level++) {
    const queue = buckets[level];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      if (dist[i] !== level) continue; // stale entry
      const x = i % width;
      const y = (i / width) | 0;
      for (let k = 0; k < 4; k++) {
        const dx = k === 0 ? -1 : k === 1 ? 1 : 0;
        const dy = k === 2 ? -1 : k === 3 ? 1 : 0;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const nd = Math.max(level, stepCost(x, y, dx, dy));
        if (nd < dist[j]) {
          dist[j] = nd;
          buckets[nd].push(j);
        }
      }
    }
    buckets[level] = [];
  }

  // Turn the bottleneck cost into a 0..1 background-likeness.
  const score = new Float32Array(n);
  const sigma = 6 / QUANT;
  for (let i = 0; i < n; i++) score[i] = Math.exp(-((dist[i] / sigma) ** 2));
  return score;
}

interface ScoreChoice {
  score: Float32Array;
  threshold: number;
  strategy: string;
  quality: number;
  all: Record<string, number>;
}

/**
 * Score the photo under both lightness models and keep the one whose histogram
 * splits most cleanly — Otsu's separability, discounted when the resulting
 * silhouette would be an implausible fraction of the frame.
 */
function chooseScoreMap(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bgSamples: Array<[number, number, number]> | undefined,
  forceStrategy: string | undefined,
): ScoreChoice {
  const lab = toLab(data, width, height);
  const { samples, sides } = borderSamples(lab, width, height);

  const candidates: Array<{ key: string; score: Float32Array }> = [];
  for (const model of MODELS) {
    const clusters = clusterBackground(samples, samples.length / 3, model, sides);
    if (bgSamples) {
      for (const [r, g, b] of bgSamples) {
        const [L, A, B] = rgbToLab(r, g, b);
        clusters.push({ l: L, a: A, b: B, sigma: 9, share: 1, sides: 4 });
      }
    }
    candidates.push({ key: `${model.key}/connected`, score: borderConnectedScore(lab, width, height, model, clusters) });
    candidates.push({ key: `${model.key}/colour`, score: scoreAgainstClusters(lab, width * height, clusters, model) });
  }

  const all: Record<string, number> = {};
  let best: ScoreChoice | null = null;
  let forced: ScoreChoice | null = null;

  for (const candidate of candidates) {
    const score = candidate.score;
    const { threshold, separability } = otsuSplit(score);

    let foreground = 0;
    for (let i = 0; i < score.length; i++) if (score[i] < threshold) foreground++;
    const coverage = foreground / score.length;

    // A silhouette filling under 1% or over 70% of the frame is almost always a
    // failed split rather than a real object.
    const plausible = coverage >= 0.01 && coverage <= 0.7;
    const quality = separability * (plausible ? 1 : 0.25);
    all[candidate.key] = quality;

    const choice: ScoreChoice = { score, threshold, strategy: candidate.key, quality, all };
    if (!best || quality > best.quality) best = choice;
    if (forceStrategy && candidate.key === forceStrategy) forced = choice;
  }
  return forced ?? best!;
}

/** Otsu threshold over a 0..1 score map, with the resulting class separability. */
function otsuSplit(score: Float32Array): { threshold: number; separability: number } {
  const nb = 128;
  const hist = new Float32Array(nb);
  for (let i = 0; i < score.length; i++) {
    hist[Math.min(nb - 1, Math.max(0, Math.floor(score[i] * nb)))]++;
  }
  const total = score.length;
  let sum = 0;
  for (let i = 0; i < nb; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let i = 0; i < nb; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  let mean = 0;
  for (let i = 0; i < nb; i++) mean += (i * hist[i]) / total;
  let variance = 0;
  for (let i = 0; i < nb; i++) variance += ((i - mean) ** 2 * hist[i]) / total;
  const separability = variance > 0 ? bestVar / (total * total * variance) : 0;

  return { threshold: (best + 0.5) / nb, separability };
}

function dilate(mask: Uint8Array, width: number, height: number, out: Uint8Array) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (mask[yy * width + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[i] = on ? 255 : 0;
    }
  }
}

function erode(mask: Uint8Array, width: number, height: number, out: Uint8Array) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (!mask[yy * width + xx]) {
            all = 0;
            break;
          }
        }
      }
      out[i] = all ? 255 : 0;
    }
  }
}

function morphOpenClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  let a = new Uint8Array(mask);
  let b = new Uint8Array(mask.length);
  for (let i = 0; i < radius; i++) {
    erode(a, width, height, b);
    [a, b] = [b, a];
  }
  for (let i = 0; i < radius * 2; i++) {
    dilate(a, width, height, b);
    [a, b] = [b, a];
  }
  for (let i = 0; i < radius; i++) {
    erode(a, width, height, b);
    [a, b] = [b, a];
  }
  return a;
}

/** Keep only the biggest connected blob — drops shadows and stray specks. */
function keepLargestComponent(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length).fill(-1);
  const stack = new Int32Array(mask.length);
  let bestLabel = -1;
  let bestArea = 0;
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let area = 0;
    while (sp > 0) {
      const i = stack[--sp];
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (mask[j] && labels[j] < 0) {
            labels[j] = label;
            stack[sp++] = j;
          }
        }
      }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = label;
    }
    label++;
  }
  if (bestLabel < 0) return;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && labels[i] !== bestLabel) mask[i] = 0;
  }
}

/** Flood the background inwards from the frame; anything unreached is a hole. */
function fillHoles(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let sp = 0;
  const push = (i: number) => {
    if (!seen[i] && !mask[i]) {
      seen[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !seen[i]) mask[i] = 255;
  }
}

export function segmentImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: Partial<SegmentOptions> = {},
): SegmentResult {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const chosen = chooseScoreMap(data, width, height, opts.bgSamples, opts.forceStrategy);
  const score = chosen.score;

  let threshold = opts.threshold;
  if (opts.autoThreshold) {
    // Otsu splits background-looking from object-looking pixels; the slider then
    // biases that split rather than replacing it.
    threshold = chosen.threshold * (0.5 + opts.threshold * 2);
  }
  threshold = Math.min(0.999, Math.max(0.001, threshold));

  let mask: Uint8Array = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = score[i] < threshold ? 255 : 0;

  if (opts.crop) {
    const { x, y, w, h } = opts.crop;
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        if (xx < x || xx >= x + w || yy < y || yy >= y + h) mask[yy * width + xx] = 0;
      }
    }
  }
  if (opts.paint) {
    for (let i = 0; i < mask.length; i++) {
      const p = opts.paint[i];
      if (p === 1) mask[i] = 255;
      else if (p === 2) mask[i] = 0;
    }
  }

  mask = morphOpenClose(mask, width, height, Math.round(opts.cleanup));
  if (opts.keepLargest) keepLargestComponent(mask, width, height);
  if (opts.fillHoles) fillHoles(mask, width, height);
  if (opts.paint) {
    for (let i = 0; i < mask.length; i++) {
      const p = opts.paint[i];
      if (p === 1) mask[i] = 255;
      else if (p === 2) mask[i] = 0;
    }
  }

  let count = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }

  return {
    mask,
    width,
    height,
    coverage: count / (width * height),
    bbox: count > 0 ? { x0, y0, x1, y1 } : null,
    usedThreshold: threshold,
    strategy: chosen.strategy,
    strategyQuality: chosen.quality,
    strategyScores: chosen.all,
  };
}

/**
 * Signed Euclidean distance transform (8SSEDT), positive inside the mask.
 * Feeding the carve a continuous distance instead of a 0/1 test is what gives
 * the final mesh sub-voxel accuracy rather than a blocky staircase.
 */
export function signedDistanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
  smoothPasses = 2,
): Float32Array {
  const inside = edt(mask, width, height, true);
  const outside = edt(mask, width, height, false);
  let out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = mask[i] ? inside[i] - 0.5 : -(outside[i] - 0.5);
  }
  // Distances measured on a pixel grid step in whole pixels, and those steps
  // show up on the carved model as fine horizontal banding. A light blur keeps
  // the zero crossing where it is while removing the staircase.
  for (let pass = 0; pass < smoothPasses; pass++) out = blur3(out, width, height);
  return out;
}

function blur3(src: Float32Array, width: number, height: number): Float32Array<ArrayBuffer> {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = x > 0 ? src[i - 1] : src[i];
      const r = x < width - 1 ? src[i + 1] : src[i];
      tmp[i] = 0.25 * l + 0.5 * src[i] + 0.25 * r;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const u = y > 0 ? tmp[i - width] : tmp[i];
      const d = y < height - 1 ? tmp[i + width] : tmp[i];
      dst[i] = 0.25 * u + 0.5 * tmp[i] + 0.25 * d;
    }
  }
  return dst;
}

const FAR = 1e7;

function edt(mask: Uint8Array, width: number, height: number, forInside: boolean): Float32Array {
  // Distance from each pixel to the nearest pixel of the opposite class.
  const dx = new Float32Array(width * height);
  const dy = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const isTarget = forInside ? !mask[i] : !!mask[i];
    if (isTarget) {
      dx[i] = 0;
      dy[i] = 0;
    } else {
      dx[i] = FAR;
      dy[i] = FAR;
    }
  }

  const dist = (i: number) => dx[i] * dx[i] + dy[i] * dy[i];
  const compare = (i: number, ox: number, oy: number, nx: number, ny: number) => {
    const j = i + oy * width + ox;
    const cx = dx[j] + nx;
    const cy = dy[j] + ny;
    if (cx * cx + cy * cy < dist(i)) {
      dx[i] = cx;
      dy[i] = cy;
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) compare(i, -1, 0, 1, 0);
      if (y > 0) compare(i, 0, -1, 0, 1);
      if (x > 0 && y > 0) compare(i, -1, -1, 1, 1);
      if (x < width - 1 && y > 0) compare(i, 1, -1, 1, 1);
    }
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) compare(i, 1, 0, 1, 0);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) compare(i, 1, 0, 1, 0);
      if (y < height - 1) compare(i, 0, 1, 0, 1);
      if (x < width - 1 && y < height - 1) compare(i, 1, 1, 1, 1);
      if (x > 0 && y < height - 1) compare(i, -1, 1, 1, 1);
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) compare(i, -1, 0, 1, 0);
    }
  }

  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(dist(i));
  return out;
}
