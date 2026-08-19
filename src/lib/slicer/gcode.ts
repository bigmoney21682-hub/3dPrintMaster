import { unitsToMm, type Path } from './geometry';
import type { PathKind, PlannedLayer } from './plan';
import { extrusionArea, type ResolvedSettings } from './settings';

/**
 * G-code writer.
 *
 * Only commands the target firmware is known to accept are emitted. That
 * distinction matters: FlashForge's own firmware ignores a command it does not
 * recognise, but the Klipper-based Adventurer 5M aborts the print on one, so
 * `M132` and `M73` are limited to the machines that want them.
 */

export interface GcodeResult {
  gcode: string;
  /** Seconds, estimated with a trapezoidal acceleration model. */
  estimatedSeconds: number;
  filamentMm: number;
  filamentGrams: number;
  layerCount: number;
  /** Bounding box actually written, in bed coordinates. */
  extent: { minX: number; minY: number; maxX: number; maxY: number; maxZ: number };
  warnings: string[];
}

const ACCELERATION = 1000; // mm/s², only used for the time estimate

interface Position {
  x: number;
  y: number;
  z: number;
}

export function generateGcode(
  layers: PlannedLayer[],
  settings: ResolvedSettings,
  onProgress?: (fraction: number, label: string) => void,
): GcodeResult {
  const { machine, material } = settings;
  const out: string[] = [];
  const warnings: string[] = [];

  const offsetX = machine.origin === 'center' ? 0 : machine.bed.x / 2;
  const offsetY = machine.origin === 'center' ? 0 : machine.bed.y / 2;

  const filamentArea = Math.PI * (material.filamentDiameter / 2) ** 2;

  let e = 0;
  let retracted = false;
  let seconds = 0;
  let filamentMm = 0;
  let currentFan = -1;
  const pos: Position = { x: 0, y: 0, z: 0 };
  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: 0 };

  const f = (n: number) => (Math.abs(n) < 0.00005 ? '0' : n.toFixed(3).replace(/\.?0+$/, ''));
  const feed = (mmPerSecond: number) => Math.round(mmPerSecond * 60);

  // The mesh was already scaled and centred before slicing, so all that is
  // left is moving the origin to wherever this machine keeps it.
  const toBedX = (units: number) => unitsToMm(units) + offsetX;
  const toBedY = (units: number) => unitsToMm(units) + offsetY;

  const trackExtent = (x: number, y: number) => {
    if (x < extent.minX) extent.minX = x;
    if (x > extent.maxX) extent.maxX = x;
    if (y < extent.minY) extent.minY = y;
    if (y > extent.maxY) extent.maxY = y;
  };

  const moveTime = (distance: number, speed: number) => {
    if (distance <= 0 || speed <= 0) return 0;
    const accelDistance = (speed * speed) / (2 * ACCELERATION);
    if (2 * accelDistance <= distance) {
      return (2 * speed) / ACCELERATION + (distance - 2 * accelDistance) / speed;
    }
    const peak = Math.sqrt(ACCELERATION * distance);
    return (2 * peak) / ACCELERATION;
  };

  const retract = () => {
    if (retracted || settings.retractionMm <= 0) return;
    e -= settings.retractionMm;
    out.push(`G1 E${f(e)} F${feed(settings.retractionSpeed)}`);
    seconds += settings.retractionMm / settings.retractionSpeed;
    retracted = true;
  };

  const unretract = () => {
    if (!retracted) return;
    e += settings.retractionMm;
    out.push(`G1 E${f(e)} F${feed(settings.retractionSpeed)}`);
    seconds += settings.retractionMm / settings.retractionSpeed;
    retracted = false;
  };

  const travelTo = (x: number, y: number) => {
    const distance = Math.hypot(x - pos.x, y - pos.y);
    if (distance < 0.0001) return;
    if (distance >= settings.minTravelForRetract) retract();
    if (settings.zHop > 0 && retracted) {
      out.push(`G1 Z${f(pos.z + settings.zHop)} F${feed(settings.travelSpeed)}`);
    }
    out.push(`G0 X${f(x)} Y${f(y)} F${feed(settings.travelSpeed)}`);
    if (settings.zHop > 0 && retracted) {
      out.push(`G1 Z${f(pos.z)} F${feed(settings.travelSpeed)}`);
    }
    seconds += moveTime(distance, settings.travelSpeed);
    pos.x = x;
    pos.y = y;
    trackExtent(x, y);
  };

  const speedFor = (kind: PathKind, layerIndex: number): number => {
    if (layerIndex === 0) return settings.firstLayerSpeed;
    switch (kind) {
      case 'external-perimeter':
        return settings.externalPerimeterSpeed;
      case 'perimeter':
      case 'brim':
      case 'skirt':
        return settings.perimeterSpeed;
      case 'solid-infill':
        return settings.solidInfillSpeed;
      case 'support':
        return settings.infillSpeed;
      default:
        return settings.infillSpeed;
    }
  };

  const emitPath = (points: Path, closed: boolean, kind: PathKind, layer: PlannedLayer) => {
    if (points.length < 2) return;
    const speed = speedFor(kind, layer.index);
    const area = extrusionArea(layer.extrusionWidth, layer.layerHeight) * settings.flow;
    const ePerMm = area / filamentArea;

    const first = points[0];
    travelTo(toBedX(first.X), toBedY(first.Y));
    unretract();

    out.push(`; ${kind}`);
    const sequence = closed ? [...points.slice(1), points[0]] : points.slice(1);
    let pathLength = 0;
    for (const point of sequence) {
      const x = toBedX(point.X);
      const y = toBedY(point.Y);
      const distance = Math.hypot(x - pos.x, y - pos.y);
      if (distance < 0.0001) continue;
      e += distance * ePerMm;
      filamentMm += distance * ePerMm;
      pathLength += distance;
      out.push(`G1 X${f(x)} Y${f(y)} E${f(e)} F${feed(speed)}`);
      pos.x = x;
      pos.y = y;
      trackExtent(x, y);
    }
    seconds += moveTime(pathLength, speed);
  };

  // --- header -------------------------------------------------------------
  const maxZ = layers.length > 0 ? layers[layers.length - 1].printZ : 0;
  out.push(
    '; generated by 3dPrintMaster',
    `; machine: ${machine.name} (${machine.origin} origin, ${machine.firmware} firmware)`,
    `; material: ${material.name}`,
    `; layer height: ${settings.layerHeight} mm, ${settings.perimeters} perimeters, ${settings.infillDensity}% infill`,
    `; layers: ${layers.length}`,
  );

  const startTemplate = machine.startGcode
    .replace(/\{bed_temp\}/g, String(machine.heatedBed ? material.firstLayerBedTemp : 0))
    .replace(/\{nozzle_temp\}/g, String(material.firstLayerNozzleTemp));
  out.push(startTemplate);

  // --- prime line ---------------------------------------------------------
  const primeY = machine.origin === 'center' ? -machine.bed.y / 2 + 4 : 4;
  const primeX0 = machine.origin === 'center' ? -machine.bed.x / 2 + 6 : 6;
  const primeX1 = primeX0 + Math.min(80, machine.bed.x - 12);
  const primeArea = extrusionArea(settings.firstLayerExtrusionWidth * 1.2, settings.firstLayerHeight);
  const primeE = ((primeX1 - primeX0) * primeArea) / filamentArea;
  out.push(
    '; prime line',
    `G1 Z${f(settings.firstLayerHeight)} F600`,
    `G0 X${f(primeX0)} Y${f(primeY)} F${feed(settings.travelSpeed)}`,
    'G92 E0',
    `G1 X${f(primeX1)} Y${f(primeY)} E${f(primeE)} F${feed(20)}`,
    'G92 E0',
  );
  pos.x = primeX1;
  pos.y = primeY;
  pos.z = settings.firstLayerHeight;
  seconds += (primeX1 - primeX0) / 20 + 6;

  // --- layers -------------------------------------------------------------
  layers.forEach((layer, index) => {
    if (layer.paths.length === 0) return;
    out.push(`;LAYER:${index}`, `;Z:${f(layer.printZ)}`);
    if (machine.firmware === 'flashforge') {
      out.push(`M73 P${Math.round((index / Math.max(1, layers.length)) * 100)}`);
    }

    if (index === 1) {
      // Drop to the running temperatures once the first layer is down.
      if (material.nozzleTemp !== material.firstLayerNozzleTemp) {
        out.push(`M104 S${material.nozzleTemp}`);
      }
      if (machine.heatedBed && material.bedTemp !== material.firstLayerBedTemp) {
        out.push(`M140 S${material.bedTemp}`);
      }
    }

    const wantFan = index < material.fanOffLayers ? 0 : Math.round((material.fanSpeed / 100) * 255);
    if (wantFan !== currentFan) {
      out.push(wantFan === 0 ? 'M107' : `M106 S${wantFan}`);
      currentFan = wantFan;
    }

    if (Math.abs(layer.printZ - pos.z) > 0.0001) {
      out.push(`G1 Z${f(layer.printZ)} F${feed(settings.travelSpeed / 4)}`);
      seconds += Math.abs(layer.printZ - pos.z) / (settings.travelSpeed / 4);
      pos.z = layer.printZ;
    }
    extent.maxZ = Math.max(extent.maxZ, layer.printZ);
    out.push('G92 E0');
    e = 0;

    for (const path of layer.paths) emitPath(path.points, path.closed, path.kind, layer);

    if (index % 20 === 0) onProgress?.(0.9 + (index / layers.length) * 0.1, 'Writing G-code');
  });

  retract();
  out.push(
    machine.endGcode
      .replace(/\{safe_z\}/g, f(Math.min(machine.bed.z, maxZ + 10)))
      .replace(/\{bed_temp\}/g, '0')
      .replace(/\{nozzle_temp\}/g, '0'),
  );

  // --- checks -------------------------------------------------------------
  const half = { x: machine.bed.x / 2, y: machine.bed.y / 2 };
  const bedMinX = machine.origin === 'center' ? -half.x : 0;
  const bedMaxX = machine.origin === 'center' ? half.x : machine.bed.x;
  const bedMinY = machine.origin === 'center' ? -half.y : 0;
  const bedMaxY = machine.origin === 'center' ? half.y : machine.bed.y;

  if (extent.minX < bedMinX || extent.maxX > bedMaxX || extent.minY < bedMinY || extent.maxY > bedMaxY) {
    warnings.push(
      `The toolpath runs outside the bed (X ${extent.minX.toFixed(1)}…${extent.maxX.toFixed(1)}, ` +
        `Y ${extent.minY.toFixed(1)}…${extent.maxY.toFixed(1)} against a ${machine.bed.x}×${machine.bed.y} mm bed). ` +
        'Scale the model down, or check the bed origin setting.',
    );
  }
  if (maxZ > machine.bed.z) {
    warnings.push(`The model is ${maxZ.toFixed(1)} mm tall but the machine allows ${machine.bed.z} mm.`);
  }
  if (!machine.heatedBed && material.bedTemp > 0) {
    warnings.push(`${machine.name} has no heated bed, so bed heating commands were sent as 0.`);
  }

  return {
    gcode: out.join('\n') + '\n',
    estimatedSeconds: seconds,
    filamentMm,
    filamentGrams: (filamentMm * filamentArea * material.density) / 1000,
    layerCount: layers.length,
    extent: isFinite(extent.minX) ? extent : { minX: 0, minY: 0, maxX: 0, maxY: 0, maxZ },
    warnings,
  };
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${total} s`;
}
