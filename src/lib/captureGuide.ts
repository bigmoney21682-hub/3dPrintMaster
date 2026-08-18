/**
 * How many photos do you actually need?
 *
 * With a silhouette/visual-hull reconstruction the answer is driven by angular
 * spacing: every extra viewpoint slices one more plane off the block. Below 8
 * shots the object still has visible flat facets where no camera ever looked.
 */

export interface CaptureTier {
  photos: number;
  spacingDeg: number;
  label: string;
  quality: number; // 0..1, for the readiness meter
  detail: string;
}

export const MINIMUM_FOR_3D = 8;
export const RECOMMENDED = 16;

export const CAPTURE_TIERS: CaptureTier[] = [
  {
    photos: 1,
    spacingDeg: 0,
    label: 'Relief only',
    quality: 0.08,
    detail:
      'One photo carries no depth. You can still print a relief, a lithophane or a flat cut-out of it, but not a true 3D object.',
  },
  {
    photos: 2,
    spacingDeg: 90,
    label: 'Very rough',
    quality: 0.2,
    detail:
      'Two shots 90 degrees apart give the intersection of a front and a side profile. Good enough for a blocky keepsake, nothing more.',
  },
  {
    photos: 4,
    spacingDeg: 90,
    label: 'Blocky',
    quality: 0.38,
    detail: 'Four shots capture the footprint but leave obvious flat facets at the 45 degree corners.',
  },
  {
    photos: 8,
    spacingDeg: 45,
    label: 'Minimum for a real 3D print',
    quality: 0.6,
    detail:
      'Eight shots at 45 degrees is the practical floor: the result is recognisably the object and prints cleanly, with mild faceting on curved surfaces.',
  },
  {
    photos: 12,
    spacingDeg: 30,
    label: 'Good',
    quality: 0.74,
    detail: 'Twelve shots smooth out most faceting on rounded objects.',
  },
  {
    photos: 16,
    spacingDeg: 22.5,
    label: 'Recommended',
    quality: 0.85,
    detail:
      'Sixteen shots is the sweet spot: smooth curves, clean edges, and still quick to shoot and to carve.',
  },
  {
    photos: 24,
    spacingDeg: 15,
    label: 'Detailed',
    quality: 0.94,
    detail: 'Twenty-four shots resolves thin features like handles, spouts and narrow gaps.',
  },
  {
    photos: 36,
    spacingDeg: 10,
    label: 'Maximum useful',
    quality: 1,
    detail:
      'Past about 36 shots a silhouette carve stops improving — the remaining error is concavity, which no number of outlines can see.',
  },
];

export interface CaptureAssessment {
  tier: CaptureTier;
  next: CaptureTier | null;
  quality: number;
  canReconstruct3D: boolean;
  headline: string;
  advice: string;
}

export function assessCapture(photoCount: number): CaptureAssessment {
  const tier =
    [...CAPTURE_TIERS].reverse().find((t) => photoCount >= t.photos) ?? CAPTURE_TIERS[0];
  const next = CAPTURE_TIERS.find((t) => t.photos > photoCount) ?? null;

  const idx = CAPTURE_TIERS.indexOf(tier);
  const upper = CAPTURE_TIERS[idx + 1];
  let quality = tier.quality;
  if (upper) {
    const span = upper.photos - tier.photos;
    const into = Math.min(1, Math.max(0, (photoCount - tier.photos) / span));
    quality = tier.quality + into * (upper.quality - tier.quality);
  }
  if (photoCount === 0) quality = 0;

  const canReconstruct3D = photoCount >= 2;
  let headline: string;
  if (photoCount === 0) headline = 'Add photos to begin';
  else if (photoCount < MINIMUM_FOR_3D)
    headline = `${photoCount} photo${photoCount === 1 ? '' : 's'} — ${MINIMUM_FOR_3D - photoCount} more to reach the 3D minimum`;
  else if (photoCount < RECOMMENDED) headline = `${photoCount} photos — above the 8 photo minimum`;
  else headline = `${photoCount} photos — ${tier.label.toLowerCase()}`;

  const advice = next
    ? `${tier.detail} Add ${next.photos - photoCount} more for "${next.label}" (${next.photos} shots, one every ${next.spacingDeg}°).`
    : tier.detail;

  return { tier, next, quality, canReconstruct3D, headline, advice };
}

export const CAPTURE_STEPS: string[] = [
  'Put the object on a plain, evenly lit surface that contrasts with it — a sheet of paper, a plain tea towel, a mouse mat.',
  'Keep the camera at the height of the middle of the object and hold that height for every shot.',
  'Rotate the object (or walk around it) by an even step and shoot again, all the way around 360 degrees.',
  'Do not move closer or further away, and do not zoom, between shots.',
  'Avoid hard shadows pooling next to the object — they get read as part of its outline.',
];
