/** Decoding, downscaling and canvas helpers shared by the UI and the worker. */

export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Working resolution for segmentation and carving. */
export const WORK_SIZES = [384, 512, 640, 800] as const;
export const DEFAULT_WORK_SIZE = 512;

async function decode(blob: Blob): Promise<ImageBitmap> {
  // `from-image` makes portrait phone photos come out the right way up.
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function drawToCanvas(bitmap: ImageBitmap, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

export async function loadRaster(blob: Blob, maxDim = DEFAULT_WORK_SIZE): Promise<RasterImage> {
  const bitmap = await decode(blob);
  try {
    const canvas = drawToCanvas(bitmap, maxDim);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await decode(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality);
  });
}

export async function makeThumbnail(blob: Blob, size = 320): Promise<Blob> {
  const bitmap = await decode(blob);
  try {
    return await canvasToBlob(drawToCanvas(bitmap, size), 'image/jpeg', 0.78);
  } finally {
    bitmap.close();
  }
}

/**
 * Re-encode a full-size phone photo down to something sane before storing it.
 * A 12MP JPEG is ~4MB; 1600px on the long edge keeps every detail the carve can
 * use and costs a tenth of the space.
 */
export async function normalisePhoto(blob: Blob, maxDim = 1600): Promise<Blob> {
  const bitmap = await decode(blob);
  try {
    if (Math.max(bitmap.width, bitmap.height) <= maxDim && blob.size < 1_500_000) return blob;
    return await canvasToBlob(drawToCanvas(bitmap, maxDim), 'image/jpeg', 0.86);
  } finally {
    bitmap.close();
  }
}

/** Paint a silhouette mask over a photo for the mask editor. */
export function drawMaskOverlay(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  width: number,
  height: number,
  rgba: [number, number, number, number] = [56, 189, 248, 110],
) {
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    d[j] = rgba[0];
    d[j + 1] = rgba[1];
    d[j + 2] = rgba[2];
    d[j + 3] = rgba[3];
  }
  ctx.putImageData(img, 0, 0);
}

/** Outline-only rendering of a mask, for compact previews. */
export function maskToOutlineCanvas(mask: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const edge =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width];
      const j = i * 4;
      d[j] = edge ? 250 : 56;
      d[j + 1] = edge ? 204 : 189;
      d[j + 2] = edge ? 21 : 248;
      d[j + 3] = edge ? 255 : 90;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
