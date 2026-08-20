/** Decoding, downscaling and canvas helpers shared by the UI and the worker. */

export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Working resolution for segmentation and carving. */
export const WORK_SIZES = [384, 512, 640, 800] as const;
export const DEFAULT_WORK_SIZE = 512;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** Thrown when the stored bytes for a photo can no longer be decoded. */
export class ImageDecodeError extends Error {
  constructor(cause?: unknown) {
    super('That photo could not be read. Remove it and add it again.');
    this.name = 'ImageDecodeError';
    this.cause = cause;
  }
}

/** `<img>` decode, for browsers or blobs that `createImageBitmap` chokes on. */
function decodeViaElement(blob: Blob): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageDecodeError());
    };
    img.src = url;
  });
}

async function decode(blob: Blob): Promise<Decoded> {
  if (blob.size === 0) throw new ImageDecodeError();
  try {
    // `from-image` makes portrait phone photos come out the right way up.
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch (err) {
    // Either the options are unsupported or the blob's bytes are unreadable —
    // a File handed to IndexedDB whose backing file has since gone away throws
    // here. The element path can still rescue some of those, so try it.
    try {
      return await decodeViaElement(blob);
    } catch {
      throw new ImageDecodeError(err);
    }
  }
}

function drawToCanvas(image: Decoded, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.source, 0, 0, w, h);
  return canvas;
}

export async function loadRaster(blob: Blob, maxDim = DEFAULT_WORK_SIZE): Promise<RasterImage> {
  const image = await decode(blob);
  try {
    const canvas = drawToCanvas(image, maxDim);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: canvas.width, height: canvas.height };
  } finally {
    image.close();
  }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const image = await decode(blob);
  const size = { width: image.width, height: image.height };
  image.close();
  return size;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality);
  });
}

export async function makeThumbnail(blob: Blob, size = 320): Promise<Blob> {
  const image = await decode(blob);
  try {
    return await canvasToBlob(drawToCanvas(image, size), 'image/jpeg', 0.78);
  } finally {
    image.close();
  }
}

/**
 * Re-encode a full-size phone photo down to something sane before storing it.
 * A 12MP JPEG is ~4MB; 1600px on the long edge keeps every detail the carve can
 * use and costs a tenth of the space.
 */
export async function normalisePhoto(blob: Blob, maxDim = 1600): Promise<Blob> {
  const image = await decode(blob);
  try {
    if (Math.max(image.width, image.height) <= maxDim && blob.size < 1_500_000) {
      /*
       * Never hand the caller the File it gave us. IndexedDB stores a File as a
       * reference to the file on disk, so once the picker's temporary copy is
       * cleaned up the stored photo decodes to nothing — which is what carving a
       * gallery import used to fail with. Copying the bytes makes it a real blob
       * that lives in the database.
       */
      return new Blob([await blob.arrayBuffer()], { type: blob.type || 'image/jpeg' });
    }
    return await canvasToBlob(drawToCanvas(image, maxDim), 'image/jpeg', 0.86);
  } finally {
    image.close();
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
