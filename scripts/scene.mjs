/** Shared synthetic scene used by the test-photo generator and the debug tools. */
import { Buffer } from 'node:buffer';

const W = 320;
const H = 420;
const SCALE = 300; // pixels per world unit
const BOTTOM = 380;
const CENTRE = W / 2;

// Signed distance field of the subject, in object space. Y is up, the object
// stands on y = 0 and is a bit under 1 unit tall.
function sdf(x, y, z) {
  const sphere = (px, py, pz, r) => Math.hypot(px, py, pz) - r;
  const body = sphere(x, y - 0.34, z, 0.34);
  const head = sphere(x, y - 0.76, z, 0.21);
  // A nose so the object is obviously asymmetric as it turns.
  const nose = sphere((x - 0.2) * 1.7, (y - 0.78) * 1.1, z * 1.7, 0.13);
  // An ear on the opposite side, at a different height.
  const ear = sphere((x + 0.26) * 1.3, (y - 0.58) * 1.0, z * 2.2, 0.14);
  const smoothUnion = (a, b, k) => {
    const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
    return b * (1 - h) + a * h - k * h * (1 - h);
  };
  let d = smoothUnion(body, head, 0.08);
  d = smoothUnion(d, nose, 0.05);
  d = smoothUnion(d, ear, 0.05);
  return Math.max(d, -y); // cut flat at the turntable
}

function normal(x, y, z) {
  const e = 0.002;
  return [
    sdf(x + e, y, z) - sdf(x - e, y, z),
    sdf(x, y + e, z) - sdf(x, y - e, z),
    sdf(x, y, z + e) - sdf(x, y, z - e),
  ];
}

export function renderScene(angleDeg) {
  const t = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rgba = Buffer.alloc(W * H * 4);
  const truth = new Uint8Array(W * H); // ground-truth silhouette, object only

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      const u = (px - CENTRE) / SCALE;
      const v = (BOTTOM - py) / SCALE;

      // Plain paper backdrop with a soft gradient, like a lit sheet.
      const shade = 232 - 26 * (py / H) - 10 * Math.abs(px / W - 0.5);
      let r = shade;
      let g = shade - 3;
      let b = shade - 12;

      // March along the view ray (camera looks down -Z from +Z).
      let zc = 1.6;
      let hit = false;
      for (let step = 0; step < 96 && zc > -1.6; step++) {
        // Camera space -> object space: undo the turntable rotation.
        const x = u * cos - zc * sin;
        const z = u * sin + zc * cos;
        const d = sdf(x, v, z);
        if (d < 0.0012) {
          const n = normal(x, v, z);
          const len = Math.hypot(n[0], n[1], n[2]) || 1;
          // Light from the upper left of the camera, rotated into object space.
          const lx = -0.5 * cos - 0.6 * sin;
          const lz = -0.5 * sin + 0.6 * cos;
          const lambert = Math.max(0.12, (n[0] * lx + n[1] * 0.62 + n[2] * lz) / len);
          r = 60 + 150 * lambert;
          g = 120 + 120 * lambert;
          b = 95 + 130 * lambert;
          hit = true;
          truth[py * W + px] = 255;
          break;
        }
        zc -= Math.max(d * 0.85, 0.0015);
      }

      // Contact shadow: darkest where the object meets the surface and fading
      // out in every direction, the way a real soft light source casts it.
      if (!hit && v < 0.03) {
        const across = Math.max(0, 1 - Math.abs(u) / 0.5);
        const below = Math.max(0, 1 - (0.03 - v) / 0.18);
        const fade = across * across * below * below;
        r -= 46 * fade;
        g -= 46 * fade;
        b -= 42 * fade;
      }

      rgba[i] = Math.max(0, Math.min(255, r));
      rgba[i + 1] = Math.max(0, Math.min(255, g));
      rgba[i + 2] = Math.max(0, Math.min(255, b));
      rgba[i + 3] = 255;
    }
  }
  return { rgba, truth, width: W, height: H };
}

export function renderRgba(angleDeg) {
  return renderScene(angleDeg).rgba;
}


export { W, H, SCALE, BOTTOM, CENTRE, sdf };
