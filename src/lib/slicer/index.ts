export * from './geometry';
export * from './gcode';
export * from './gx';
export * from './infill';
export * from './machines';
export * from './plan';
export * from './settings';
export * from './sliceMesh';

import type { PathKind } from './plan';

/** Compact codes so tool paths can be shipped to the UI as typed arrays. */
export const PATH_KINDS: PathKind[] = [
  'external-perimeter',
  'perimeter',
  'solid-infill',
  'infill',
  'skirt',
  'brim',
  'support',
];

export const PATH_COLOURS: Record<PathKind, string> = {
  'external-perimeter': '#f5b642',
  perimeter: '#38d5f8',
  'solid-infill': '#8b7bf0',
  infill: '#4a6a8f',
  skirt: '#59d999',
  brim: '#59d999',
  support: '#7c8aa5',
};

export interface PreviewData {
  printZ: Float32Array;
  layerStart: Uint32Array;
  pathStart: Uint32Array;
  pathKind: Uint8Array;
  points: Float32Array;
}

export interface SliceStats {
  estimatedSeconds: number;
  filamentMm: number;
  filamentGrams: number;
  layerCount: number;
  openContours: number;
  warnings: string[];
  extent: { minX: number; minY: number; maxX: number; maxY: number; maxZ: number };
}
