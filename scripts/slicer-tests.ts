// @ts-nocheck
/** Slicer checks, appended to the main self-test run. */
import type { Mesh } from '../src/lib/mesh';
import { sliceMesh } from '../src/lib/slicer/sliceMesh';
import { regionArea, unitsToMm } from '../src/lib/slicer/geometry';
import { buildGx, THUMBNAIL_SIZE } from '../src/lib/slicer/gx';
import { planPrint, prepareMesh } from '../src/lib/slicer/plan';
import { generateGcode } from '../src/lib/slicer/gcode';
import { DEFAULT_SETTINGS, resolveSettings } from '../src/lib/slicer/settings';
import { meshToBinarySTL, parseSTL } from '../src/lib/stl';
import { meshBounds } from '../src/lib/mesh';

/** Axis-aligned box, Z-up, sitting on Z=0, with outward normals. */
export function boxMesh(sx: number, sy: number, sz: number, z0 = 0): Mesh {
  const hx = sx / 2;
  const hy = sy / 2;
  const v = [
    [-hx, -hy, z0], [hx, -hy, z0], [hx, hy, z0], [-hx, hy, z0],
    [-hx, -hy, z0 + sz], [hx, -hy, z0 + sz], [hx, hy, z0 + sz], [-hx, hy, z0 + sz],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], // bottom, normal -Z
    [4, 5, 6], [4, 6, 7], // top, normal +Z
    [0, 1, 5], [0, 5, 4], // -Y
    [1, 2, 6], [1, 6, 5], // +X
    [2, 3, 7], [2, 7, 6], // +Y
    [3, 0, 4], [3, 4, 7], // -X
  ];
  const positions = new Float32Array(v.flat());
  return { positions, indices: new Uint32Array(faces.flat()) };
}

/** Vertical prism with `sides` faces — a stand-in for a cylinder. */
export function cylinderMesh(radius: number, height: number, sides = 64): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const ring = (z: number) => {
    const base = positions.length / 3;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
    }
    return base;
  };
  const bottom = ring(0);
  const top = ring(height);
  const centreBottom = positions.length / 3;
  positions.push(0, 0, 0);
  const centreTop = positions.length / 3;
  positions.push(0, 0, height);

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(bottom + i, bottom + j, top + j);
    indices.push(bottom + i, top + j, top + i);
    indices.push(centreBottom, bottom + j, bottom + i);
    indices.push(centreTop, top + i, top + j);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Square tube: a box with a square hole all the way through. */
export function tubeMesh(outer: number, inner: number, height: number): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
  const ho = outer / 2;
  const hi = inner / 2;
  const corners = (h: number, z: number) => [
    push(-h, -h, z), push(h, -h, z), push(h, h, z), push(-h, h, z),
  ];
  const ob = corners(ho, 0);
  const ot = corners(ho, height);
  const ib = corners(hi, 0);
  const it = corners(hi, height);

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(ob[i], ob[j], ot[j], ot[i]);   // outer wall, normal outward
    quad(ib[j], ib[i], it[i], it[j]);   // inner wall, normal into the hole
    quad(ob[j], ob[i], ib[i], ib[j]);   // bottom ring, normal -Z
    quad(ot[i], ot[j], it[j], it[i]);   // top ring, normal +Z
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function runSlicerChecks(check, near) {
  console.log('\nSlicing primitives');
  {
    const mesh = boxMesh(20, 20, 10);
    const { layers, openContours } = sliceMesh(mesh, { layerHeight: 0.2, firstLayerHeight: 0.25 });
    check('cube: no open contours', openContours === 0, `${openContours} open`);
    near('cube: layer count', layers.length, 1 + (10 - 0.25) / 0.2, 1);
    check('cube: one loop per layer', layers.every((l) => l.paths.length === 1), 'loops per layer');
    const areas = layers.map((l) => regionArea(l.paths));
    near('cube: cross-section area', areas[Math.floor(areas.length / 2)], 400, 0.05);
    near('cube: first layer at 0.25', layers[0].printZ, 0.25, 1e-9);
    check(
      'cube: every layer has the same area',
      Math.max(...areas) - Math.min(...areas) < 0.05,
      `spread ${(Math.max(...areas) - Math.min(...areas)).toFixed(4)} mm²`,
    );
  }
  {
    const mesh = cylinderMesh(8, 6, 128);
    const { layers } = sliceMesh(mesh, { layerHeight: 0.2, firstLayerHeight: 0.2 });
    const area = regionArea(layers[Math.floor(layers.length / 2)].paths);
    // The mesh is a 128-gon inscribed in the circle, so its area is slightly
    // under πr² — compare against the polygon, not the ideal circle.
    const polygonArea = 0.5 * 128 * 64 * Math.sin((2 * Math.PI) / 128);
    near('cylinder: cross-section area', area, polygonArea, 0.3);
  }
  {
    const mesh = tubeMesh(20, 10, 5);
    const { layers, openContours } = sliceMesh(mesh, { layerHeight: 0.2, firstLayerHeight: 0.2 });
    check('tube: no open contours', openContours === 0, `${openContours} open`);
    const mid = layers[Math.floor(layers.length / 2)];
    check('tube: two loops per layer', mid.paths.length === 2, `${mid.paths.length} loops`);
    near('tube: area is outer minus hole', regionArea(mid.paths), 400 - 100, 0.05);
  }

  console.log('\nLayer planning');
  {
    const settings = resolveSettings({ ...DEFAULT_SETTINGS, machineId: 'adventurer-3', infillDensity: 20 });
    const { layers } = planPrint(boxMesh(20, 20, 10), settings);
    const mid = layers[Math.floor(layers.length / 2)];
    const externals = mid.paths.filter((p) => p.kind === 'external-perimeter').length;
    const internals = mid.paths.filter((p) => p.kind === 'perimeter').length;
    check('one external perimeter per layer', externals === 1, `${externals}`);
    check('one internal perimeter per layer', internals === 1, `${internals}`);
    check('external perimeter printed last of the shells', (() => {
      const kinds = mid.paths.map((p) => p.kind);
      return kinds.indexOf('external-perimeter') > kinds.indexOf('perimeter');
    })(), 'ordering');
    check('middle layers use sparse infill', mid.paths.some((p) => p.kind === 'infill'), 'has sparse infill');
    check('middle layers are not fully solid', !mid.paths.some((p) => p.kind === 'solid-infill'), 'no solid infill');

    const bottom = layers[0];
    check('first layer is solid', bottom.paths.some((p) => p.kind === 'solid-infill'), 'has solid infill');
    check('first layer has a skirt', bottom.paths.some((p) => p.kind === 'skirt'), 'has skirt');
    const top = layers[layers.length - 1];
    check('last layer is solid', top.paths.some((p) => p.kind === 'solid-infill'), 'has solid infill');
    check('last layer has no sparse infill', !top.paths.some((p) => p.kind === 'infill'), 'sparse-free');
  }
  {
    // A flat overhang must get solid material where it starts, not just at the
    // very top of the model.
    const wide = boxMesh(20, 20, 2, 0);
    const narrow = boxMesh(6, 6, 4, 2);
    const merged = {
      positions: new Float32Array([...wide.positions, ...narrow.positions]),
      indices: new Uint32Array([
        ...wide.indices,
        ...Array.from(narrow.indices, (i) => i + wide.positions.length / 3),
      ]),
    };
    const settings = resolveSettings({ ...DEFAULT_SETTINGS, infillDensity: 15 });
    const { layers } = planPrint(merged, settings);
    const stepLayer = layers.findIndex((l) => l.printZ > 1.4 && l.printZ < 1.95);
    check(
      'top surface under a step is solid',
      layers[stepLayer].paths.some((p) => p.kind === 'solid-infill'),
      `layer ${stepLayer} at z=${layers[stepLayer].printZ.toFixed(2)}`,
    );
  }

  console.log('\nSupport material');
  {
    // A table: a narrow leg with a wide top that cannot hold itself up.
    const leg = boxMesh(6, 6, 4, 0);
    const top = boxMesh(20, 20, 2, 4);
    const table = {
      positions: new Float32Array([...leg.positions, ...top.positions]),
      indices: new Uint32Array([...leg.indices, ...Array.from(top.indices, (i) => i + leg.positions.length / 3)]),
    };

    const off = resolveSettings({ ...DEFAULT_SETTINGS, supports: false });
    const withSupport = resolveSettings({ ...DEFAULT_SETTINGS, supports: true });
    const plainLayers = planPrint(table, off).layers;
    const supportedLayers = planPrint(table, withSupport).layers;

    check(
      'no support paths when supports are off',
      !plainLayers.some((l) => l.paths.some((p) => p.kind === 'support')),
      'none present',
    );

    const underOverhang = supportedLayers.filter((l) => l.printZ > 1 && l.printZ < 3.9);
    check(
      'support appears under the overhang',
      underOverhang.every((l) => l.paths.some((p) => p.kind === 'support')),
      `${underOverhang.filter((l) => l.paths.some((p) => p.kind === 'support')).length}/${underOverhang.length} layers`,
    );

    const aboveOverhang = supportedLayers.filter((l) => l.printZ > 4.5);
    check(
      'no support above the overhang',
      !aboveOverhang.some((l) => l.paths.some((p) => p.kind === 'support')),
      `${aboveOverhang.length} layers checked`,
    );

    // Support must sit outside the leg, not inside it.
    const sample = underOverhang[Math.floor(underOverhang.length / 2)];
    const supportPoints = sample.paths
      .filter((p) => p.kind === 'support')
      .flatMap((p) => p.points);
    const insideLeg = supportPoints.filter(
      (pt) => Math.abs(unitsToMm(pt.X)) < 3.5 && Math.abs(unitsToMm(pt.Y)) < 3.5,
    ).length;
    check('support keeps clear of the model', insideLeg === 0, `${insideLeg} points inside the leg`);
    const far = supportPoints.filter((pt) => Math.abs(unitsToMm(pt.X)) > 10.5 || Math.abs(unitsToMm(pt.Y)) > 10.5).length;
    check('support stays under the overhang footprint', far === 0, `${far} points beyond the top`);

    const supported = generateGcode(supportedLayers, withSupport);
    const plain = generateGcode(plainLayers, off);
    check('supports use extra material', supported.filamentMm > plain.filamentMm * 1.05, `${(supported.filamentMm / plain.filamentMm).toFixed(2)}x`);
  }

  console.log('\n.gx container');
  {
    const settings = resolveSettings({ ...DEFAULT_SETTINGS });
    const { layers } = planPrint(boxMesh(20, 20, 3), settings);
    const g = generateGcode(layers, settings);
    const rgb = new Uint8Array(THUMBNAIL_SIZE.width * THUMBNAIL_SIZE.height * 3).fill(40);
    const gx = buildGx(g.gcode, rgb, {
      printSeconds: g.estimatedSeconds,
      filamentMm: g.filamentMm,
      layerHeightMm: settings.layerHeight,
      shells: settings.perimeters,
      printSpeedMmS: settings.perimeterSpeed,
      bedTemp: 55,
      nozzleTemp: 205,
    });
    const view = new DataView(gx.buffer, gx.byteOffset, gx.byteLength);
    const magic = String.fromCharCode(...gx.slice(0, 10));
    check('.gx magic string', magic === 'xgcode 1.0', magic);
    const bmpOffset = view.getUint32(16, true);
    const gcodeOffset = view.getUint32(20, true);
    check('.gx thumbnail offset', bmpOffset === 58, String(bmpOffset));
    check('.gx duplicate gcode offset matches', gcodeOffset === view.getUint32(24, true), String(gcodeOffset));
    check('.gx thumbnail is a BMP', gx[bmpOffset] === 0x42 && gx[bmpOffset + 1] === 0x4d, 'BM header');
    const bmpSize = new DataView(gx.buffer, gx.byteOffset + bmpOffset).getUint32(2, true);
    check('.gx thumbnail size is consistent', bmpSize === gcodeOffset - bmpOffset, `${bmpSize} vs ${gcodeOffset - bmpOffset}`);
    const back = new TextDecoder().decode(gx.slice(gcodeOffset));
    check('.gx carries the G-code unchanged', back === g.gcode, 'byte identical');
    check('.gx header records the layer height', view.getUint16(42, true) === 200, String(view.getUint16(42, true)));
  }

  console.log('\nSTL round trip');
  {
    const original = boxMesh(20, 20, 6);
    const stl = meshToBinarySTL(original, 'roundtrip');
    const back = parseSTL(stl);
    check('triangle count survives', back.indices.length === original.indices.length, `${back.indices.length / 3} triangles`);
    const a = meshBounds(original);
    const b = meshBounds(back);
    near('bounds survive (x)', b.max[0] - b.min[0], a.max[0] - a.min[0], 1e-4);
    near('bounds survive (z)', b.max[2] - b.min[2], a.max[2] - a.min[2], 1e-4);
    const sliced = sliceMesh(back, { layerHeight: 0.2, firstLayerHeight: 0.2 });
    check('a re-imported STL still slices closed', sliced.openContours === 0, `${sliced.openContours} open contours`);
    near('re-imported cross-section area', regionArea(sliced.layers[3].paths), 400, 0.05);
  }

  console.log('\nG-code output');
  {
    const settings = resolveSettings({ ...DEFAULT_SETTINGS, machineId: 'adventurer-3', infillDensity: 100 });
    const { layers } = planPrint(boxMesh(20, 20, 5), settings);
    const result = generateGcode(layers, settings);
    const lines = result.gcode.split('\n');

    check('no bed warnings for a 20 mm cube', result.warnings.length === 0, result.warnings.join('; ') || 'none');
    check('has a start and an end block', /M109 S215/.test(result.gcode) && /M18/.test(result.gcode), 'blocks');
    check('resets the extruder each layer', (result.gcode.match(/G92 E0/g) ?? []).length >= result.layerCount, 'G92 count');

    // Every coordinate must land on the bed. Adventurer 3: 150x150, centred.
    let outOfBounds = 0;
    let maxZ = 0;
    let lastZ = -1;
    let zWentBackwards = 0;
    const endIndex = lines.findIndex((l) => l.includes('machine end'));
    for (const line of lines.slice(0, endIndex > 0 ? endIndex : undefined)) {
      const mx = /(?:^|\s)X(-?\d+(?:\.\d+)?)/.exec(line);
      const my = /(?:^|\s)Y(-?\d+(?:\.\d+)?)/.exec(line);
      if (/^G[01] /.test(line)) {
        if (mx && Math.abs(Number(mx[1])) > 75.001) outOfBounds++;
        if (my && Math.abs(Number(my[1])) > 75.001) outOfBounds++;
        const mz = /(?:^|\s)Z(-?\d+(?:\.\d+)?)/.exec(line);
        if (mz) {
          const z = Number(mz[1]);
          if (z < lastZ - 0.0001 && z > 0) zWentBackwards++;
          lastZ = z;
          maxZ = Math.max(maxZ, z);
        }
      }
    }
    check('every move stays on the bed', outOfBounds === 0, `${outOfBounds} out-of-bounds coordinates`);
    check('Z never goes backwards mid-print', zWentBackwards === 0, `${zWentBackwards} descents`);
    near('final Z matches the model height', maxZ, 5, 0.3);

    // Extruded volume should match the solid it is filling, within the slack
    // that perimeters, skirt and rounding introduce.
    const volume = (result.filamentMm * Math.PI * (1.75 / 2) ** 2) / 1000; // cm³
    const expected = (20 * 20 * 5) / 1000;
    check(
      'extruded volume matches a solid 20x20x5 block',
      volume > expected * 0.9 && volume < expected * 1.15,
      `${volume.toFixed(2)} cm³ vs ${expected.toFixed(2)} cm³`,
    );
    check('estimates a sensible print time', result.estimatedSeconds > 60 && result.estimatedSeconds < 20000, `${Math.round(result.estimatedSeconds)} s`);
    check('reports filament weight', result.filamentGrams > 1 && result.filamentGrams < 20, `${result.filamentGrams.toFixed(1)} g`);
  }
  {
    // Klipper machines abort on unknown commands, so those must not appear.
    const settings = resolveSettings({ ...DEFAULT_SETTINGS, machineId: 'adventurer-5m' });
    const { layers } = planPrint(boxMesh(20, 20, 2), settings);
    const result = generateGcode(layers, settings);
    check('no FlashForge-only commands for a Klipper machine', !/M132|M73/.test(result.gcode), 'M132/M73 absent');
    check('front-left origin puts the model in the bed centre', /G0 X1[01]\d(\.\d+)? Y1[01]\d/.test(result.gcode), 'coordinates around 110');
    check('no negative coordinates on a front-left machine', !/[XY]-\d/.test(result.gcode.split(';LAYER:1')[1] ?? ''), 'all positive');
  }
  {
    // Oversized model must be reported rather than silently printed off the bed.
    const settings = resolveSettings({ ...DEFAULT_SETTINGS, machineId: 'finder' });
    const { layers } = planPrint(boxMesh(200, 200, 2), settings);
    const result = generateGcode(layers, settings);
    check('oversized model raises a warning', result.warnings.some((w) => w.includes('outside the bed')), result.warnings[0] ?? 'none');
  }
  {
    // Scaling is a true 3D scale, so material use follows the cube of it.
    const base = resolveSettings({ ...DEFAULT_SETTINGS, infillDensity: 100 });
    const half = resolveSettings({ ...DEFAULT_SETTINGS, infillDensity: 100, scalePercent: 50 });
    const full = generateGcode(planPrint(prepareMesh(boxMesh(20, 20, 8), 100), base).layers, base);
    const small = generateGcode(planPrint(prepareMesh(boxMesh(20, 20, 8), 50), half).layers, half);
    const ratio = small.filamentMm / full.filamentMm;
    check('scaling to 50% uses about an eighth of the material', ratio > 0.09 && ratio < 0.2, `${ratio.toFixed(3)} of full size`);
    near('scaling to 50% halves the height', small.extent.maxZ, full.extent.maxZ / 2, 0.4);
  }
}
