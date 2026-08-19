import { boundsOf, clipLines, mmToUnits, SCALE, type Path, type Paths } from './geometry';

/**
 * Fill patterns. Lines are generated across the layer's bounding box, clipped
 * to the region, then ordered so the nozzle zig-zags instead of hopping about.
 */

/** Parallel lines at `angleDeg`, spaced `spacingMm` apart, covering `region`. */
export function hatch(region: Paths, spacingMm: number, angleDeg: number, phase = 0): Paths {
  const bounds = boundsOf(region);
  if (!bounds || spacingMm <= 0) return [];

  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const spacing = spacingMm * SCALE;

  // Work in a rotated frame, then rotate the lines back.
  const corners = [
    { X: bounds.minX, Y: bounds.minY },
    { X: bounds.maxX, Y: bounds.minY },
    { X: bounds.maxX, Y: bounds.maxY },
    { X: bounds.minX, Y: bounds.maxY },
  ];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const c of corners) {
    const u = c.X * cos + c.Y * sin;
    const v = -c.X * sin + c.Y * cos;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  const lines: Paths = [];
  const start = Math.ceil((minV - phase * spacing) / spacing) * spacing + phase * spacing;
  const margin = spacing;
  for (let v = start; v <= maxV + 1e-6; v += spacing) {
    const a = { X: Math.round((minU - margin) * cos - v * sin), Y: Math.round((minU - margin) * sin + v * cos) };
    const b = { X: Math.round((maxU + margin) * cos - v * sin), Y: Math.round((maxU + margin) * sin + v * cos) };
    lines.push([a, b]);
  }
  return clipLines(lines, region);
}

/**
 * Order clipped segments into a sensible travel sequence: repeatedly take the
 * nearest endpoint to where the nozzle is, flipping segments as needed.
 */
export function orderSegments(segments: Paths, from: { X: number; Y: number }): Paths {
  const remaining = segments.map((s) => s.slice());
  const ordered: Paths = [];
  let cursor = { ...from };

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestFlip = false;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i];
      const head = seg[0];
      const tail = seg[seg.length - 1];
      const dHead = (head.X - cursor.X) ** 2 + (head.Y - cursor.Y) ** 2;
      const dTail = (tail.X - cursor.X) ** 2 + (tail.Y - cursor.Y) ** 2;
      if (dHead < bestDistance) {
        bestDistance = dHead;
        bestIndex = i;
        bestFlip = false;
      }
      if (dTail < bestDistance) {
        bestDistance = dTail;
        bestIndex = i;
        bestFlip = true;
      }
    }
    const [seg] = remaining.splice(bestIndex, 1);
    const path = bestFlip ? seg.slice().reverse() : seg;
    ordered.push(path);
    cursor = { ...path[path.length - 1] };
  }
  return ordered;
}

/** Rotate a closed loop so it begins at the vertex nearest `from`. */
export function seamAt(loop: Path, from: { X: number; Y: number }): Path {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i].X - from.X) ** 2 + (loop[i].Y - from.Y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best === 0 ? loop : [...loop.slice(best), ...loop.slice(0, best)];
}

export function spacingForDensity(extrusionWidth: number, densityPercent: number): number {
  const density = Math.min(100, Math.max(0.5, densityPercent));
  return mmToUnits(extrusionWidth) / SCALE / (density / 100);
}
