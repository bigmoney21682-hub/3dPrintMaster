import type { Mesh } from '../mesh';
import { meshBounds } from '../mesh';
import { difference, intersection, offset, union, type Path, type Paths } from './geometry';
import { hatch, orderSegments, seamAt, spacingForDensity } from './infill';
import { sliceMesh } from './sliceMesh';
import type { ResolvedSettings } from './settings';

export type PathKind =
  | 'external-perimeter'
  | 'perimeter'
  | 'solid-infill'
  | 'infill'
  | 'skirt'
  | 'brim'
  | 'support';

export interface ToolPath {
  kind: PathKind;
  points: Path;
  closed: boolean;
}

export interface PlannedLayer {
  index: number;
  printZ: number;
  layerHeight: number;
  extrusionWidth: number;
  paths: ToolPath[];
}

export interface PlanResult {
  layers: PlannedLayer[];
  openContours: number;
}

/**
 * Scale the model and drop it onto the middle of the bed.
 *
 * Scaling has to happen before slicing, not while writing coordinates: doing it
 * at write time would shrink X and Y while leaving the layer heights alone,
 * which silently squashes the model.
 */
export function prepareMesh(mesh: Mesh, scalePercent: number): Mesh {
  const scale = scalePercent / 100;
  const b = meshBounds(mesh);
  const cx = ((b.min[0] + b.max[0]) / 2) * scale;
  const cy = ((b.min[1] + b.max[1]) / 2) * scale;
  const bottom = b.min[2] * scale;

  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i] * scale - cx;
    positions[i + 1] = mesh.positions[i + 1] * scale - cy;
    positions[i + 2] = mesh.positions[i + 2] * scale - bottom;
  }
  return { positions, indices: mesh.indices };
}

/**
 * Turn a mesh into ordered tool paths.
 *
 * The two structural decisions here:
 *
 *  - Perimeters print inside-out so the external one lands last on a settled
 *    surface, which is what makes the outside look clean.
 *  - A layer's solid area is whatever is *not* covered by every one of the next
 *    few layers above (a top surface) or below (a bottom surface). Comparing
 *    regions this way is what puts solid material under overhangs and over
 *    holes, instead of only at the very top and bottom of the print.
 */
export function planPrint(
  mesh: Mesh,
  settings: ResolvedSettings,
  onProgress?: (fraction: number, label: string) => void,
): PlanResult {
  const { layers: contourLayers, openContours } = sliceMesh(mesh, {
    layerHeight: settings.layerHeight,
    firstLayerHeight: settings.firstLayerHeight,
    onProgress: (f) => onProgress?.(f * 0.35, 'Slicing layers'),
  });

  const widthFor = (i: number) => (i === 0 ? settings.firstLayerExtrusionWidth : settings.extrusionWidth);

  // Pass 1: perimeters, and the region left over for infill.
  const perimeterPaths: ToolPath[][] = [];
  const innerRegions: Paths[] = [];

  contourLayers.forEach((layer, i) => {
    const width = widthFor(i);
    const paths: ToolPath[] = [];
    const loops: Paths[] = [];

    for (let k = 0; k < settings.perimeters; k++) {
      const inset = -(width / 2 + k * width);
      const region = offset(layer.paths, inset);
      if (region.length === 0) break;
      loops.push(region);
    }

    // Inside out: innermost perimeter first, external one last.
    for (let k = loops.length - 1; k >= 0; k--) {
      for (const loop of loops[k]) {
        paths.push({ kind: k === 0 ? 'external-perimeter' : 'perimeter', points: loop, closed: true });
      }
    }
    perimeterPaths.push(paths);

    // Infill starts half a bead inside the last perimeter, then reaches back
    // out a little so it welds to it.
    const shells = loops.length || 1;
    const overlap = width * 0.18;
    innerRegions.push(offset(layer.paths, -(shells * width) + overlap));

    if (i % 16 === 0) onProgress?.(0.35 + (i / contourLayers.length) * 0.25, 'Building perimeters');
  });

  // Pass 2: which parts of each layer must be solid.
  const solidRegions: Paths[] = [];
  const sparseRegions: Paths[] = [];

  for (let i = 0; i < innerRegions.length; i++) {
    const inner = innerRegions[i];
    if (inner.length === 0) {
      solidRegions.push([]);
      sparseRegions.push([]);
      continue;
    }

    const coveredAbove = coverage(innerRegions, i, 1, settings.topLayers);
    const coveredBelow = coverage(innerRegions, i, -1, settings.bottomLayers);
    const top = settings.topLayers > 0 ? difference(inner, coveredAbove) : [];
    const bottom = settings.bottomLayers > 0 ? difference(inner, coveredBelow) : [];

    let solid = union(top, bottom);
    if (solid.length > 0) {
      // Grow slightly so solid areas tie into the perimeters, then clip back.
      solid = intersection(offset(solid, widthFor(i)), inner);
    }
    solidRegions.push(solid);
    sparseRegions.push(settings.infillDensity > 0 ? difference(inner, solid) : []);

    if (i % 16 === 0) onProgress?.(0.6 + (i / innerRegions.length) * 0.2, 'Finding top and bottom');
  }

  // Pass 2b: where the model overhangs too far to hold itself up.
  const supportRegions = settings.supports
    ? planSupports(contourLayers.map((l) => l.paths), settings, onProgress)
    : [];

  // Pass 3: fill.
  const layers: PlannedLayer[] = contourLayers.map((layer, i) => {
    const width = widthFor(i);
    const paths = [...perimeterPaths[i]];
    let cursor = paths.length > 0 ? paths[paths.length - 1].points[0] : { X: 0, Y: 0 };

    const solid = solidRegions[i];
    if (solid.length > 0) {
      const angle = i % 2 === 0 ? 45 : 135;
      const segments = orderSegments(hatch(solid, width, angle), cursor);
      for (const seg of segments) paths.push({ kind: 'solid-infill', points: seg, closed: false });
      if (segments.length > 0) cursor = segments[segments.length - 1].slice(-1)[0];
    }

    const sparse = sparseRegions[i];
    if (sparse.length > 0 && settings.infillDensity > 0) {
      const spacing = spacingForDensity(width, settings.infillDensity);
      const segments = fillSparse(sparse, spacing, i, settings.infillPattern, cursor);
      for (const seg of segments) {
        paths.push({ kind: 'infill', points: seg.points, closed: seg.closed });
      }
    }

    const support = supportRegions[i];
    if (support && support.length > 0) {
      // One outline keeps the support columns from curling, then loose lines
      // inside it so it snaps off easily.
      const wall = offset(support, -width / 2);
      for (const loop of wall) paths.push({ kind: 'support', points: loop, closed: true });
      const spacing = spacingForDensity(width, settings.supportDensity);
      const inner = offset(support, -width);
      if (inner.length > 0) {
        const segments = orderSegments(hatch(inner, spacing, i % 2 === 0 ? 0 : 90), cursor);
        for (const seg of segments) paths.push({ kind: 'support', points: seg, closed: false });
      }
    }

    return {
      index: i,
      printZ: layer.printZ,
      layerHeight: i === 0 ? settings.firstLayerHeight : settings.layerHeight,
      extrusionWidth: width,
      paths,
    };
  });

  onProgress?.(0.85, 'Adding skirt');
  addSkirtAndBrim(layers, contourLayers[0]?.paths ?? [], settings);

  onProgress?.(0.9, 'Planned');
  return { layers, openContours };
}

/**
 * Work out where support is needed, walking from the top of the model down.
 *
 * A layer can hold up whatever sits within `layerHeight * tan(angle)` of its
 * own outline; anything beyond that is an overhang. Unsupported area is carried
 * downwards until it reaches the bed, minus the model itself plus a clearance
 * gap so the support peels off instead of welding on.
 */
function planSupports(
  regions: Paths[],
  settings: ResolvedSettings,
  onProgress?: (fraction: number, label: string) => void,
): Paths[] {
  const reach = settings.layerHeight * Math.tan((settings.supportOverhangAngle * Math.PI) / 180);
  const gapLayers = Math.max(1, Math.round(settings.supportZGap / settings.layerHeight));
  const supports: Paths[] = regions.map(() => []);

  // What each layer fails to hold up for the one above it.
  const overhangs: Paths[] = [];
  for (let i = 0; i < regions.length - 1; i++) {
    overhangs.push(difference(regions[i + 1], offset(regions[i], reach)));
  }

  let carried: Paths = [];
  for (let i = regions.length - 2; i >= 0; i--) {
    // Pull in the overhang spotted a few layers higher, so the column stops
    // short of the surface it holds up and snaps off cleanly.
    const source = i + gapLayers;
    if (source < overhangs.length) carried = union(carried, overhangs[source]);
    if (carried.length === 0) continue;

    const clear = difference(carried, offset(regions[i], settings.supportXYGap));
    // Anything narrower than a single bead cannot be printed, so open it away.
    supports[i] = offset(offset(clear, -settings.extrusionWidth), settings.extrusionWidth);
    carried = clear;

    if (i % 32 === 0) onProgress?.(0.8, 'Planning supports');
  }
  return supports;
}

/** Intersection of the `count` regions in `direction` from layer `i`. */
function coverage(regions: Paths[], i: number, direction: 1 | -1, count: number): Paths {
  if (count <= 0) return [];
  let result: Paths | null = null;
  for (let k = 1; k <= count; k++) {
    const j = i + direction * k;
    // Off the end of the model means nothing covers this layer: it is a surface.
    if (j < 0 || j >= regions.length) return [];
    result = result === null ? regions[j] : intersection(result, regions[j]);
    if (result.length === 0) return [];
  }
  return result ?? [];
}

function fillSparse(
  region: Paths,
  spacing: number,
  layerIndex: number,
  pattern: ResolvedSettings['infillPattern'],
  cursor: { X: number; Y: number },
): Array<{ points: Path; closed: boolean }> {
  if (pattern === 'concentric') {
    const loops: Array<{ points: Path; closed: boolean }> = [];
    let current = region;
    for (let ring = 0; ring < 200 && current.length > 0; ring++) {
      for (const loop of current) loops.push({ points: loop, closed: true });
      current = offset(current, -spacing);
    }
    return loops;
  }

  if (pattern === 'grid') {
    // Half density per direction so the total matches the requested density.
    const a = hatch(region, spacing * 2, 45);
    const b = hatch(region, spacing * 2, 135);
    return orderSegments([...a, ...b], cursor).map((points) => ({ points, closed: false }));
  }

  const angle = layerIndex % 2 === 0 ? 45 : 135;
  return orderSegments(hatch(region, spacing, angle), cursor).map((points) => ({ points, closed: false }));
}

function addSkirtAndBrim(layers: PlannedLayer[], firstContours: Paths, settings: ResolvedSettings) {
  const first = layers[0];
  if (!first || firstContours.length === 0) return;
  const width = settings.firstLayerExtrusionWidth;
  const prefix: ToolPath[] = [];

  if (settings.brimWidth > 0) {
    const rings = Math.max(1, Math.round(settings.brimWidth / width));
    for (let k = rings; k >= 1; k--) {
      const region = offset(firstContours, width * (k - 0.5));
      for (const loop of region) prefix.push({ kind: 'brim', points: loop, closed: true });
    }
  }

  if (settings.skirtLoops > 0) {
    const base = settings.brimWidth > 0 ? settings.brimWidth : 0;
    for (let k = settings.skirtLoops; k >= 1; k--) {
      const distance = base + settings.skirtDistance + (k - 0.5) * width;
      const region = offset(union(firstContours), distance, true);
      for (const loop of region) prefix.push({ kind: 'skirt', points: loop, closed: true });
    }
  }

  first.paths = [...prefix, ...first.paths];
}

/** Rotate every closed loop so its seam sits near the previous path's end. */
export function placeSeams(layer: PlannedLayer, start: { X: number; Y: number }) {
  let cursor = start;
  for (const path of layer.paths) {
    if (path.closed) path.points = seamAt(path.points, cursor);
    cursor = path.points[path.points.length - 1];
  }
}
