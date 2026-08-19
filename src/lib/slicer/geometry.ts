import * as ClipperLib from 'clipper-lib';

/**
 * Polygon plumbing for the slicer.
 *
 * Clipper works in integers, so everything is held in microns internally and
 * converted at the edges. Offsetting and boolean operations are the two things
 * a slicer absolutely must get right — self-intersections, collapsing thin
 * walls, holes merging into their outer shell — so they go through Clipper
 * rather than anything hand-rolled.
 */

export const SCALE = 1000; // integer units per millimetre

export type Point = ClipperLib.IntPoint;
export type Path = Point[];
export type Paths = Path[];

export function mmToUnits(mm: number): number {
  return Math.round(mm * SCALE);
}

export function unitsToMm(units: number): number {
  return units / SCALE;
}

const NON_ZERO = ClipperLib.PolyFillType.pftNonZero;

function run(clipType: ClipperLib.ClipType, subject: Paths, clip: Paths): Paths {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const solution: Paths = [];
  clipper.Execute(clipType, solution, NON_ZERO, NON_ZERO);
  return solution;
}

/** Merge overlapping contours and normalise winding (outer CCW, holes CW). */
export function union(paths: Paths, other: Paths = []): Paths {
  if (paths.length === 0 && other.length === 0) return [];
  return run(ClipperLib.ClipType.ctUnion, paths, other);
}

export function difference(subject: Paths, clip: Paths): Paths {
  if (subject.length === 0) return [];
  if (clip.length === 0) return subject.map((p) => p.slice());
  return run(ClipperLib.ClipType.ctDifference, subject, clip);
}

export function intersection(subject: Paths, clip: Paths): Paths {
  if (subject.length === 0 || clip.length === 0) return [];
  return run(ClipperLib.ClipType.ctIntersection, subject, clip);
}

/**
 * Grow (positive) or shrink (negative) regions by a distance in millimetres.
 * Miter joins keep corners sharp; the limit stops spikes at very acute angles.
 */
export function offset(paths: Paths, deltaMm: number, round = false): Paths {
  if (paths.length === 0) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  co.AddPaths(
    paths,
    round ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon,
  );
  const solution: Paths = [];
  co.Execute(solution, deltaMm * SCALE);
  return solution;
}

/** Drop collinear points and specks below `toleranceMm`, which G-code loves. */
export function clean(paths: Paths, toleranceMm = 0.008): Paths {
  if (paths.length === 0) return [];
  const cleaned = ClipperLib.Clipper.CleanPolygons(paths, toleranceMm * SCALE);
  return cleaned.filter((p) => p.length >= 3);
}

export function pathArea(path: Path): number {
  return ClipperLib.Clipper.Area(path) / (SCALE * SCALE);
}

/** Signed area in mm²; holes contribute negatively, so this is the solid area. */
export function regionArea(paths: Paths): number {
  return paths.reduce((sum, path) => sum + pathArea(path), 0);
}

export function pathLength(path: Path, closed = true): number {
  let total = 0;
  for (let i = 0; i < path.length - (closed ? 0 : 1); i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    total += Math.hypot(b.X - a.X, b.Y - a.Y);
  }
  return total / SCALE;
}

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(paths: Paths): Bounds2D | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      if (p.X < minX) minX = p.X;
      if (p.X > maxX) maxX = p.X;
      if (p.Y < minY) minY = p.Y;
      if (p.Y > maxY) maxY = p.Y;
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Clip open line segments to a region — how infill lines get trimmed to the
 * inside of the part.
 */
export function clipLines(lines: Paths, region: Paths): Paths {
  if (lines.length === 0 || region.length === 0) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(lines, ClipperLib.PolyType.ptSubject, false);
  clipper.AddPaths(region, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ClipperLib.ClipType.ctIntersection, tree, NON_ZERO, NON_ZERO);
  return ClipperLib.Clipper.OpenPathsFromPolyTree(tree).filter((p) => p.length >= 2);
}

/** True when the path winds counter-clockwise, i.e. it is an outer contour. */
export function isOuter(path: Path): boolean {
  return ClipperLib.Clipper.Orientation(path);
}

export function translate(paths: Paths, dxUnits: number, dyUnits: number): Paths {
  return paths.map((path) => path.map((p) => ({ X: p.X + dxUnits, Y: p.Y + dyUnits })));
}
