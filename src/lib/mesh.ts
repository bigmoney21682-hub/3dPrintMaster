/** Minimal indexed triangle mesh used across the whole reconstruction pipeline. */
export interface Mesh {
  positions: Float32Array; // xyz triples
  indices: Uint32Array; // triangle corner indices
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function meshBounds(mesh: Mesh): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Signed volume of a closed mesh. Negative means the winding is inside-out. */
export function signedVolume(mesh: Mesh): number {
  const { positions: p, indices: ix } = mesh;
  let vol = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3;
    const b = ix[i + 1] * 3;
    const c = ix[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    vol +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/** Flip triangle winding in place. */
export function flipWinding(mesh: Mesh): Mesh {
  const ix = mesh.indices;
  for (let i = 0; i < ix.length; i += 3) {
    const t = ix[i + 1];
    ix[i + 1] = ix[i + 2];
    ix[i + 2] = t;
  }
  return mesh;
}

/** Make sure outward normals really point outward. */
export function orientOutward(mesh: Mesh): Mesh {
  if (signedVolume(mesh) < 0) flipWinding(mesh);
  return mesh;
}

/**
 * Laplacian smoothing with a Taubin lambda/mu pass so the mesh keeps its volume
 * instead of slowly deflating. Operates on the shared vertex graph.
 */
export function smoothMesh(mesh: Mesh, iterations: number, lambda = 0.5, mu = -0.53): Mesh {
  if (iterations <= 0) return mesh;
  const n = mesh.positions.length / 3;
  const ix = mesh.indices;

  // Build neighbour adjacency in CSR form.
  const degree = new Uint32Array(n);
  for (let i = 0; i < ix.length; i += 3) {
    degree[ix[i]] += 2;
    degree[ix[i + 1]] += 2;
    degree[ix[i + 2]] += 2;
  }
  const offset = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i];
  const cursor = offset.slice(0, n);
  const adj = new Uint32Array(offset[n]);
  const addEdge = (a: number, b: number) => {
    adj[cursor[a]++] = b;
    adj[cursor[b]++] = a;
  };
  for (let i = 0; i < ix.length; i += 3) {
    addEdge(ix[i], ix[i + 1]);
    addEdge(ix[i + 1], ix[i + 2]);
    addEdge(ix[i + 2], ix[i]);
  }

  let src = new Float32Array(mesh.positions);
  let dst = new Float32Array(src.length);
  const step = (factor: number) => {
    for (let v = 0; v < n; v++) {
      const s = offset[v];
      const e = offset[v + 1];
      const count = e - s;
      const i3 = v * 3;
      if (count === 0) {
        dst[i3] = src[i3];
        dst[i3 + 1] = src[i3 + 1];
        dst[i3 + 2] = src[i3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let k = s; k < e; k++) {
        const j = adj[k] * 3;
        sx += src[j];
        sy += src[j + 1];
        sz += src[j + 2];
      }
      sx /= count;
      sy /= count;
      sz /= count;
      dst[i3] = src[i3] + factor * (sx - src[i3]);
      dst[i3 + 1] = src[i3 + 1] + factor * (sy - src[i3 + 1]);
      dst[i3 + 2] = src[i3 + 2] + factor * (sz - src[i3 + 2]);
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  };

  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }
  return { positions: src, indices: ix };
}

/** Scale + translate so the mesh sits on Z=0 with the requested longest edge, in mm. */
export function fitToPrintVolume(mesh: Mesh, targetLongestMm: number): Mesh {
  const b = meshBounds(mesh);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-9);
  const s = targetLongestMm / longest;
  const p = new Float32Array(mesh.positions.length);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (mesh.positions[i] - cx) * s;
    p[i + 1] = (mesh.positions[i + 1] - b.min[1]) * s;
    p[i + 2] = (mesh.positions[i + 2] - cz) * s;
  }
  return { positions: p, indices: mesh.indices };
}

/**
 * Rotate the mesh from "Y is up" (how we reconstruct) into "Z is up" (how every
 * slicer expects an STL to arrive).
 */
export function yUpToZUp(mesh: Mesh): Mesh {
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    p[i] = mesh.positions[i];
    p[i + 1] = -mesh.positions[i + 2];
    p[i + 2] = mesh.positions[i + 1];
  }
  return { positions: p, indices: mesh.indices };
}

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}
