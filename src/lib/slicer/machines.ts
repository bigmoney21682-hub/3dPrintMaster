/**
 * FlashForge machine and material presets.
 *
 * The one setting worth reading twice is `origin`. FlashForge's own firmware
 * (Creator, Dreamer, Guider, Adventurer 3/4) places 0,0 at the centre of the
 * bed, so its G-code is full of negative coordinates. The Klipper-based
 * Adventurer 5M uses the front-left corner like most other printers. Getting it
 * wrong prints in mid-air, so it is exposed in the UI and worth checking
 * against a file FlashPrint exported for your machine.
 */

export type BedOrigin = 'center' | 'front-left';

export interface MachineProfile {
  id: string;
  name: string;
  bed: { x: number; y: number; z: number };
  origin: BedOrigin;
  nozzleDiameter: number;
  heatedBed: boolean;
  maxBedTemp: number;
  /** Klipper-based machines reject unknown commands instead of ignoring them. */
  firmware: 'flashforge' | 'klipper';
  startGcode: string;
  endGcode: string;
}

const FLASHFORGE_START = `; --- machine start ---
M140 S{bed_temp} ; set bed temperature
M104 S{nozzle_temp} ; set nozzle temperature
M107 ; fan off
G90 ; absolute positioning
G28 ; home all axes
M132 X Y Z A B ; recall home offsets, after homing as FlashPrint does
M190 S{bed_temp} ; wait for bed
M109 S{nozzle_temp} ; wait for nozzle
G92 E0 ; reset extruder`;

const FLASHFORGE_END = `; --- machine end ---
M104 S0 ; nozzle off
M140 S0 ; bed off
M107 ; fan off
G92 E0
G1 E-2 F1800 ; relieve pressure
G1 Z{safe_z} F900 ; lift
G28 X Y ; park
M132 X Y Z A B
M18 ; motors off`;

const KLIPPER_START = `; --- machine start ---
M140 S{bed_temp} ; set bed temperature
M104 S{nozzle_temp} ; set nozzle temperature
M107 ; fan off
G90 ; absolute positioning
G28 ; home all axes
M190 S{bed_temp} ; wait for bed
M109 S{nozzle_temp} ; wait for nozzle
G92 E0 ; reset extruder`;

const KLIPPER_END = `; --- machine end ---
M104 S0 ; nozzle off
M140 S0 ; bed off
M107 ; fan off
G92 E0
G1 E-2 F1800 ; relieve pressure
G1 Z{safe_z} F900 ; lift
G28 X Y ; park
M84 ; motors off`;

export const MACHINES: MachineProfile[] = [
  {
    id: 'adventurer-3',
    name: 'FlashForge Adventurer 3',
    bed: { x: 150, y: 150, z: 150 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 100,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'adventurer-4',
    name: 'FlashForge Adventurer 4',
    bed: { x: 220, y: 200, z: 250 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 110,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'adventurer-5m',
    name: 'FlashForge Adventurer 5M / 5M Pro',
    bed: { x: 220, y: 220, z: 220 },
    origin: 'front-left',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 110,
    firmware: 'klipper',
    startGcode: KLIPPER_START,
    endGcode: KLIPPER_END,
  },
  {
    id: 'creator-pro',
    name: 'FlashForge Creator Pro',
    bed: { x: 227, y: 148, z: 150 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 120,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'finder',
    name: 'FlashForge Finder',
    bed: { x: 140, y: 140, z: 140 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: false,
    maxBedTemp: 0,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'guider-2',
    name: 'FlashForge Guider II / IIs',
    bed: { x: 280, y: 250, z: 300 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 120,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'dreamer',
    name: 'FlashForge Dreamer',
    bed: { x: 230, y: 150, z: 140 },
    origin: 'center',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 120,
    firmware: 'flashforge',
    startGcode: FLASHFORGE_START,
    endGcode: FLASHFORGE_END,
  },
  {
    id: 'generic',
    name: 'Generic FDM printer',
    bed: { x: 200, y: 200, z: 200 },
    origin: 'front-left',
    nozzleDiameter: 0.4,
    heatedBed: true,
    maxBedTemp: 110,
    firmware: 'klipper',
    startGcode: KLIPPER_START,
    endGcode: KLIPPER_END,
  },
];

export interface MaterialProfile {
  id: string;
  name: string;
  nozzleTemp: number;
  firstLayerNozzleTemp: number;
  bedTemp: number;
  firstLayerBedTemp: number;
  fanSpeed: number; // 0..100
  /** Layers printed with the fan off so the first layers stick. */
  fanOffLayers: number;
  retractionMm: number;
  filamentDiameter: number;
  /** Grams per cm³, for the weight estimate. */
  density: number;
}

export const MATERIALS: MaterialProfile[] = [
  {
    id: 'pla',
    name: 'PLA',
    nozzleTemp: 205,
    firstLayerNozzleTemp: 215,
    bedTemp: 55,
    firstLayerBedTemp: 60,
    fanSpeed: 100,
    fanOffLayers: 1,
    retractionMm: 1.5,
    filamentDiameter: 1.75,
    density: 1.24,
  },
  {
    id: 'petg',
    name: 'PETG',
    nozzleTemp: 240,
    firstLayerNozzleTemp: 245,
    bedTemp: 75,
    firstLayerBedTemp: 80,
    fanSpeed: 50,
    fanOffLayers: 2,
    retractionMm: 2,
    filamentDiameter: 1.75,
    density: 1.27,
  },
  {
    id: 'abs',
    name: 'ABS',
    nozzleTemp: 245,
    firstLayerNozzleTemp: 250,
    bedTemp: 100,
    firstLayerBedTemp: 105,
    fanSpeed: 0,
    fanOffLayers: 3,
    retractionMm: 1.5,
    filamentDiameter: 1.75,
    density: 1.04,
  },
  {
    id: 'tpu',
    name: 'TPU (flexible)',
    nozzleTemp: 225,
    firstLayerNozzleTemp: 230,
    bedTemp: 45,
    firstLayerBedTemp: 50,
    fanSpeed: 60,
    fanOffLayers: 2,
    retractionMm: 0.6,
    filamentDiameter: 1.75,
    density: 1.21,
  },
];

export function machineById(id: string): MachineProfile {
  return MACHINES.find((m) => m.id === id) ?? MACHINES[0];
}

export function materialById(id: string): MaterialProfile {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}
