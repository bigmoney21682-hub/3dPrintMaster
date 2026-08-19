/**
 * FlashPrint's `.gx` container: a 58-byte header, an 80x60 BMP thumbnail, then
 * the plain G-code. It is what FlashPrint itself writes, and some FlashForge
 * menus will only list `.gx` files.
 *
 * The header layout below follows the format as documented by the community
 * rather than anything official, so `.gcode` stays the default in the UI. If a
 * printer refuses a `.gx` file, the G-code inside it is byte-identical to the
 * plain export — renaming that to `.g` always works.
 */

const MAGIC = 'xgcode 1.0\n\0';
const HEADER_BYTES = 58;
const THUMB_W = 80;
const THUMB_H = 60;

export interface GxMetadata {
  printSeconds: number;
  filamentMm: number;
  layerHeightMm: number;
  shells: number;
  printSpeedMmS: number;
  bedTemp: number;
  nozzleTemp: number;
}

/** 24-bit bottom-up BMP. At 80 px wide the rows are already 4-byte aligned. */
export function encodeBmp(width: number, height: number, rgb: Uint8Array): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const pixelBytes = (rowBytes + padding) * height;
  const size = 54 + pixelBytes;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); // BITMAPINFOHEADER
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  let out = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      bytes[out++] = rgb[i + 2]; // BMP stores BGR
      bytes[out++] = rgb[i + 1];
      bytes[out++] = rgb[i];
    }
    out += padding;
  }
  return bytes;
}

export function buildGx(gcode: string, thumbnailRgb: Uint8Array | null, meta: GxMetadata): Uint8Array<ArrayBuffer> {
  const rgb = thumbnailRgb ?? new Uint8Array(THUMB_W * THUMB_H * 3).fill(0x14);
  const bmp = encodeBmp(THUMB_W, THUMB_H, rgb);
  const body = new TextEncoder().encode(gcode);

  const total = HEADER_BYTES + bmp.length + body.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);

  const gcodeOffset = HEADER_BYTES + bmp.length;
  view.setUint32(16, HEADER_BYTES, true); // thumbnail offset
  view.setUint32(20, gcodeOffset, true);
  view.setUint32(24, gcodeOffset, true);
  view.setUint32(28, Math.round(meta.printSeconds), true);
  view.setUint32(32, Math.round(meta.filamentMm), true); // right extruder
  view.setUint32(36, 0, true); // left extruder, unused
  view.setUint16(40, 11, true); // single extruder
  view.setUint16(42, Math.round(meta.layerHeightMm * 1000), true);
  view.setUint16(44, 0, true);
  view.setUint16(46, meta.shells, true);
  view.setUint16(48, Math.round(meta.printSpeedMmS), true);
  view.setUint16(50, Math.round(meta.bedTemp), true);
  view.setUint16(52, Math.round(meta.nozzleTemp), true);
  view.setUint16(54, 0, true); // left nozzle, unused
  view.setUint16(56, 1, true);

  bytes.set(bmp, HEADER_BYTES);
  bytes.set(body, gcodeOffset);
  return bytes;
}

export const THUMBNAIL_SIZE = { width: THUMB_W, height: THUMB_H };
