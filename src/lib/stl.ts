import type { Mesh } from './mesh';
import { triangleCount } from './mesh';

/**
 * Binary STL writer. Slicers (FlashPrint, Orca, Cura, PrusaSlicer) all read this
 * happily and it is ~5x smaller than ASCII STL for the same mesh.
 */
export function meshToBinarySTL(mesh: Mesh, header = '3dPrintMaster'): ArrayBuffer {
  const tris = triangleCount(mesh);
  const buffer = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const headerBytes = new TextEncoder().encode(header.slice(0, 79));
  bytes.set(headerBytes.subarray(0, 80), 0);
  view.setUint32(80, tris, true);

  const p = mesh.positions;
  const ix = mesh.indices;
  let off = 84;
  for (let t = 0; t < tris; t++) {
    const a = ix[t * 3] * 3;
    const b = ix[t * 3 + 1] * 3;
    const c = ix[t * 3 + 2] * 3;

    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    view.setFloat32(off + 12, ax, true);
    view.setFloat32(off + 16, ay, true);
    view.setFloat32(off + 20, az, true);
    view.setFloat32(off + 24, bx, true);
    view.setFloat32(off + 28, by, true);
    view.setFloat32(off + 32, bz, true);
    view.setFloat32(off + 36, cx, true);
    view.setFloat32(off + 40, cy, true);
    view.setFloat32(off + 44, cz, true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return buffer;
}

/**
 * Read binary or ASCII STL back into a mesh.
 *
 * The triangles are kept unwelded: the slicer matches shared edges by
 * coordinate value rather than vertex index, and STL writes identical floats
 * for a shared edge, so stitching still closes cleanly.
 */
export function parseSTL(buffer: ArrayBuffer): Mesh {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (buffer.byteLength === 84 + count * 50) return parseBinary(view, count);
  }
  return parseAscii(new TextDecoder().decode(buffer));
}

function parseBinary(view: DataView, count: number): Mesh {
  const positions = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12; // skip the facet normal
    for (let v = 0; v < 3; v++) {
      const o = base + v * 12;
      positions[t * 9 + v * 3] = view.getFloat32(o, true);
      positions[t * 9 + v * 3 + 1] = view.getFloat32(o + 4, true);
      positions[t * 9 + v * 3 + 2] = view.getFloat32(o + 8, true);
      indices[t * 3 + v] = t * 3 + v;
    }
  }
  return { positions, indices };
}

function parseAscii(text: string): Mesh {
  const values: number[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const positions = new Float32Array(values);
  const indices = new Uint32Array(values.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFilename(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w\d\-. ]+/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 64) || 'model'
  );
}
