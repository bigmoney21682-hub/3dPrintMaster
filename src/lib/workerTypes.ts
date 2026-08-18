import type { SegmentOptions } from './segment';
import type { CarveOptions } from './carve';
import type { HeightfieldOptions } from './heightfield';

export interface WirePaint {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export interface WireImage {
  data: ArrayBuffer; // RGBA
  width: number;
  height: number;
}

export interface WireView extends WireImage {
  angleDeg: number;
  options: Partial<SegmentOptions>;
  paint?: WirePaint;
}

export type WorkerRequest =
  | { id: number; type: 'segment'; image: WireImage; options: Partial<SegmentOptions>; paint?: WirePaint }
  | { id: number; type: 'reconstruct'; views: WireView[]; carve: Partial<CarveOptions> }
  | {
      id: number;
      type: 'heightfield';
      image: WireImage;
      options: Partial<HeightfieldOptions>;
      segment?: Partial<SegmentOptions>;
      paint?: WirePaint;
      useMask: boolean;
    };

export interface ViewDiagnostic {
  angleDeg: number;
  coverage: number;
  hasSilhouette: boolean;
  /** Silhouette height relative to the median across all views. */
  heightRatio: number;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'error'; message: string }
  | {
      id: number;
      type: 'segment';
      mask: ArrayBuffer;
      width: number;
      height: number;
      coverage: number;
      usedThreshold: number;
      bbox: { x0: number; y0: number; x1: number; y1: number } | null;
    }
  | {
      id: number;
      type: 'mesh';
      positions: ArrayBuffer;
      indices: ArrayBuffer;
      diagnostics: ViewDiagnostic[];
    };
