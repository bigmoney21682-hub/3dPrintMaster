import { machineById, materialById, type MachineProfile, type MaterialProfile } from './machines';

export type InfillPattern = 'rectilinear' | 'grid' | 'concentric';

export interface PrintSettings {
  machineId: string;
  materialId: string;

  layerHeight: number;
  firstLayerHeight: number;
  extrusionWidth: number;
  firstLayerExtrusionWidth: number;

  perimeters: number;
  topLayers: number;
  bottomLayers: number;

  infillDensity: number; // 0..100
  infillPattern: InfillPattern;

  // Speeds, mm/s
  perimeterSpeed: number;
  externalPerimeterSpeed: number;
  infillSpeed: number;
  solidInfillSpeed: number;
  travelSpeed: number;
  firstLayerSpeed: number;

  retractionMm: number;
  retractionSpeed: number; // mm/s
  minTravelForRetract: number; // mm
  zHop: number;

  /** Support material under overhangs. */
  supports: boolean;
  /** Steepest step, measured from vertical, a layer can hold up unaided. */
  supportOverhangAngle: number;
  supportDensity: number;
  supportZGap: number;
  supportXYGap: number;

  skirtLoops: number;
  skirtDistance: number;
  brimWidth: number;

  flow: number; // multiplier
  scalePercent: number;
}

export const DEFAULT_SETTINGS: PrintSettings = {
  machineId: 'adventurer-3',
  materialId: 'pla',

  layerHeight: 0.2,
  firstLayerHeight: 0.25,
  extrusionWidth: 0.44,
  firstLayerExtrusionWidth: 0.48,

  perimeters: 2,
  topLayers: 4,
  bottomLayers: 3,

  infillDensity: 15,
  infillPattern: 'rectilinear',

  perimeterSpeed: 45,
  externalPerimeterSpeed: 25,
  infillSpeed: 60,
  solidInfillSpeed: 45,
  travelSpeed: 120,
  firstLayerSpeed: 20,

  retractionMm: 1.5,
  retractionSpeed: 30,
  minTravelForRetract: 2,
  zHop: 0,

  supports: false,
  supportOverhangAngle: 50,
  supportDensity: 15,
  supportZGap: 0.2,
  supportXYGap: 0.7,

  skirtLoops: 2,
  skirtDistance: 3,
  brimWidth: 0,

  flow: 1,
  scalePercent: 100,
};

export interface ResolvedSettings extends PrintSettings {
  machine: MachineProfile;
  material: MaterialProfile;
}

export function resolveSettings(settings: PrintSettings): ResolvedSettings {
  const machine = machineById(settings.machineId);
  const material = materialById(settings.materialId);
  return { ...settings, machine, material };
}

/**
 * Cross-sectional area of an extruded bead: a rectangle with semicircular ends,
 * which is how the plastic actually sits on the layer below.
 */
export function extrusionArea(width: number, height: number): number {
  return height * (width - height) + Math.PI * (height / 2) ** 2;
}
