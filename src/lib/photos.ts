import { listPhotos, newId, savePhoto, type Photo } from './db';
import { imageSize, makeThumbnail, normalisePhoto } from './image';
import { defaultAngles } from './carve';

/** Store one captured or uploaded photo, resized and with a thumbnail. */
export async function addPhoto(projectId: string, source: Blob, order: number, angleDeg: number): Promise<Photo> {
  const blob = await normalisePhoto(source);
  const [thumb, size] = await Promise.all([makeThumbnail(blob), imageSize(blob)]);
  const photo: Photo = {
    id: newId('img'),
    projectId,
    order,
    angleDeg,
    blob,
    thumb,
    width: size.width,
    height: size.height,
    createdAt: Date.now(),
  };
  await savePhoto(photo);
  return photo;
}

/**
 * Spread the stored photos evenly across the turntable sweep. Called after every
 * add or delete so the angles always match the shooting instructions.
 */
export async function respaceAngles(projectId: string, sweepDeg: number): Promise<Photo[]> {
  const photos = await listPhotos(projectId);
  const angles = defaultAngles(photos.length, sweepDeg);
  await Promise.all(
    photos.map((photo, i) => {
      const next = { ...photo, order: i, angleDeg: angles[i] };
      return savePhoto(next);
    }),
  );
  return listPhotos(projectId);
}

export async function addPhotos(projectId: string, sources: Blob[], sweepDeg: number): Promise<Photo[]> {
  const existing = await listPhotos(projectId);
  let order = existing.length;
  for (const source of sources) {
    await addPhoto(projectId, source, order, 0);
    order++;
  }
  return respaceAngles(projectId, sweepDeg);
}
