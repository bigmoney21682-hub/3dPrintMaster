import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProject, listModels, saveProject, type ModelRecord, type Project } from '../lib/db';
import { parseSTL, downloadBlob, safeFilename } from '../lib/stl';
import { meshBounds, triangleCount, type Mesh } from '../lib/mesh';
import { slice, type SliceOutcome } from '../lib/sliceClient';
import { DEFAULT_SETTINGS, type InfillPattern, type PrintSettings } from '../lib/slicer/settings';
import { MACHINES, MATERIALS, machineById, materialById } from '../lib/slicer/machines';
import { formatDuration } from '../lib/slicer/gcode';
import { buildGx, THUMBNAIL_SIZE } from '../lib/slicer/gx';
import { PATH_COLOURS, PATH_KINDS, type PreviewData } from '../lib/slicer';
import { useNavigate } from '../lib/useHashRoute';
import { AppBar, ProgressOverlay, Slider, ToggleGroup, formatBytes, useToast } from './ui';
import { LayerPreview, PathLegend } from './LayerPreview';

const QUALITY_PRESETS = [
  { layerHeight: 0.3, label: 'Draft' },
  { layerHeight: 0.2, label: 'Standard' },
  { layerHeight: 0.15, label: 'Fine' },
  { layerHeight: 0.1, label: 'Ultra' },
];

export function SliceView({ projectId, modelId }: { projectId?: string; modelId?: string }) {
  const navigate = useNavigate();
  const notify = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [source, setSource] = useState<{ name: string; mesh: Mesh } | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [outcome, setOutcome] = useState<SliceOutcome | null>(null);
  const [layerIndex, setLayerIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const machine = machineById(settings.machineId);
  const material = materialById(settings.materialId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId || !modelId) return;
      const [prj, models] = await Promise.all([getProject(projectId), listModels(projectId)]);
      if (cancelled) return;
      const model: ModelRecord | undefined = models.find((m) => m.id === modelId);
      if (!model) {
        setLoadError('That model is no longer in the project.');
        return;
      }
      setProject(prj ?? null);
      if (prj?.slicer) setSettings((s) => ({ ...s, ...prj.slicer }));
      try {
        const mesh = parseSTL(await model.stl.arrayBuffer());
        if (!cancelled) setSource({ name: model.name, mesh });
      } catch {
        if (!cancelled) setLoadError('That STL could not be read.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, modelId]);

  const patch = useCallback(
    (changes: Partial<PrintSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...changes };
        if (project) void saveProject({ ...project, slicer: next });
        return next;
      });
      setOutcome(null);
    },
    [project],
  );

  const pickMaterial = (id: string) => {
    const m = materialById(id);
    patch({ materialId: id, retractionMm: m.retractionMm });
  };

  const openFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const mesh = parseSTL(await file.arrayBuffer());
      if (mesh.indices.length === 0) throw new Error('empty');
      setSource({ name: file.name.replace(/\.stl$/i, ''), mesh });
      setOutcome(null);
      setLoadError(null);
    } catch {
      notify('That file could not be read as an STL');
    }
  };

  const run = async () => {
    if (!source) return;
    setOutcome(null);
    setProgress({ fraction: 0, label: 'Slicing' });
    try {
      const result = await slice(source.mesh, settings, (fraction, label) => setProgress({ fraction, label }));
      setOutcome(result);
      setLayerIndex(Math.min(result.stats.layerCount - 1, Math.floor(result.stats.layerCount / 2)));
      notify(`Sliced into ${result.stats.layerCount} layers`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Slicing failed');
    } finally {
      setProgress(null);
    }
  };

  const exportFile = (extension: 'gcode' | 'g' | 'gx') => {
    if (!outcome || !source) return;
    const name = safeFilename(source.name);
    if (extension === 'gx') {
      const thumb = renderThumbnail(outcome.preview);
      const bytes = buildGx(outcome.gcode, thumb, {
        printSeconds: outcome.stats.estimatedSeconds,
        filamentMm: outcome.stats.filamentMm,
        layerHeightMm: settings.layerHeight,
        shells: settings.perimeters,
        printSpeedMmS: settings.perimeterSpeed,
        bedTemp: machine.heatedBed ? material.bedTemp : 0,
        nozzleTemp: material.nozzleTemp,
      });
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${name}.gx`);
      return;
    }
    downloadBlob(new Blob([outcome.gcode], { type: 'text/plain' }), `${name}.${extension}`);
  };

  const modelInfo = useMemo(() => {
    if (!source) return null;
    const b = meshBounds(source.mesh);
    const scale = settings.scalePercent / 100;
    return {
      triangles: triangleCount(source.mesh),
      size: [
        (b.max[0] - b.min[0]) * scale,
        (b.max[1] - b.min[1]) * scale,
        (b.max[2] - b.min[2]) * scale,
      ] as [number, number, number],
    };
  }, [source, settings.scalePercent]);

  const tooTall = modelInfo ? modelInfo.size[2] > machine.bed.z : false;
  const tooWide = modelInfo ? modelInfo.size[0] > machine.bed.x || modelInfo.size[1] > machine.bed.y : false;

  return (
    <>
      <AppBar
        title="Slice"
        subtitle={source ? source.name : 'for a FlashForge'}
        onBack={() => navigate(projectId ? `p/${projectId}` : '')}
      />
      <main className="stack">
        {loadError && <div className="callout bad">{loadError}</div>}

        {!source ? (
          <div className="card stack">
            <h2>Choose an STL</h2>
            <p className="muted">
              Slice a model from one of your projects, or open any STL file from this device.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".stl,model/stl,application/sla"
              className="sr-only"
              onChange={(e) => void openFile(e.target.files)}
            />
            <button className="btn primary block" onClick={() => fileRef.current?.click()}>
              Open an STL file
            </button>
            <button className="btn block" onClick={() => navigate('')}>
              Back to my projects
            </button>
          </div>
        ) : (
          <>
            <div className="card tight">
              <div className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{source.name}</strong>
                  {modelInfo && (
                    <div className="faint">
                      {modelInfo.size.map((n) => n.toFixed(1)).join(' × ')} mm ·{' '}
                      {modelInfo.triangles.toLocaleString()} triangles
                    </div>
                  )}
                </div>
                <button className="btn small ghost" onClick={() => fileRef.current?.click()}>
                  Change
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".stl,model/stl,application/sla"
                className="sr-only"
                onChange={(e) => void openFile(e.target.files)}
              />
            </div>

            {(tooTall || tooWide) && (
              <div className="callout warn">
                This model is bigger than the {machine.name} bed ({machine.bed.x} × {machine.bed.y} × {machine.bed.z}{' '}
                mm). Reduce the scale below, or pick a different machine.
              </div>
            )}

            <div className="card stack">
              <div>
                <label className="field" htmlFor="machine">
                  Printer
                </label>
                <select id="machine" value={settings.machineId} onChange={(e) => patch({ machineId: e.target.value })}>
                  {MACHINES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <div className="faint">
                  {machine.bed.x} × {machine.bed.y} × {machine.bed.z} mm ·{' '}
                  {machine.origin === 'center' ? 'origin at bed centre' : 'origin at front-left'} ·{' '}
                  {machine.heatedBed ? 'heated bed' : 'unheated bed'}
                </div>
              </div>

              <div>
                <label className="field" htmlFor="material">
                  Material
                </label>
                <select id="material" value={settings.materialId} onChange={(e) => pickMaterial(e.target.value)}>
                  {MATERIALS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <div className="faint">
                  Nozzle {material.nozzleTemp} °C · bed {machine.heatedBed ? `${material.bedTemp} °C` : 'not heated'} ·
                  fan {material.fanSpeed}%
                </div>
              </div>

              <ToggleGroup
                label="Quality"
                value={String(settings.layerHeight)}
                options={QUALITY_PRESETS.map((p) => ({ value: String(p.layerHeight), label: p.label }))}
                onChange={(v) => {
                  const layerHeight = Number(v);
                  patch({
                    layerHeight,
                    firstLayerHeight: Math.min(0.3, Math.max(0.2, layerHeight)),
                  });
                }}
              />
              <div className="faint">{settings.layerHeight} mm layers</div>

              <Slider
                label="Infill"
                value={settings.infillDensity}
                min={0}
                max={100}
                step={5}
                suffix="%"
                onChange={(v) => patch({ infillDensity: v })}
                hint="10–20% is plenty for a display piece. Solid top and bottom layers are added regardless."
              />
              <Slider
                label="Walls"
                value={settings.perimeters}
                min={1}
                max={6}
                onChange={(v) => patch({ perimeters: v })}
              />
              <Slider
                label="Scale"
                value={settings.scalePercent}
                min={10}
                max={300}
                step={5}
                suffix="%"
                onChange={(v) => patch({ scalePercent: v })}
              />

              <label className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.supports}
                  style={{ width: 20, height: 20, minHeight: 0 }}
                  onChange={(e) => patch({ supports: e.target.checked })}
                />
                <span>Print supports under overhangs</span>
              </label>
              <div className="faint">
                Scanned objects usually stand on a flat base, so supports are often unnecessary. Turn them on if the
                shape has arms, spouts or ledges that stick out over thin air.
              </div>
            </div>

            <AdvancedSettings settings={settings} onChange={patch} />

            <button className="btn primary block" onClick={run} disabled={!!progress}>
              Slice for {machine.name}
            </button>

            {outcome && (
              <>
                <div className="card stack">
                  <div className="row wrap">
                    <h2 style={{ flex: 1 }}>Result</h2>
                    <span className="chip good">{formatDuration(outcome.stats.estimatedSeconds)}</span>
                    <span className="chip">{outcome.stats.filamentGrams.toFixed(1)} g</span>
                  </div>
                  <div className="faint">
                    {outcome.stats.layerCount} layers · {(outcome.stats.filamentMm / 1000).toFixed(2)} m of filament ·{' '}
                    {formatBytes(new Blob([outcome.gcode]).size)} of G-code · footprint{' '}
                    {(outcome.stats.extent.maxX - outcome.stats.extent.minX).toFixed(1)} ×{' '}
                    {(outcome.stats.extent.maxY - outcome.stats.extent.minY).toFixed(1)} mm
                  </div>
                  {outcome.stats.warnings.map((w) => (
                    <div className="callout bad" key={w}>
                      {w}
                    </div>
                  ))}
                  {outcome.stats.openContours > 0 && (
                    <div className="callout warn">
                      {outcome.stats.openContours} contours did not close, which means the mesh has holes. The slice
                      still went ahead, but check the preview around those layers.
                    </div>
                  )}

                  <LayerPreview preview={outcome.preview} layerIndex={layerIndex} machine={machine} />
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, outcome.stats.layerCount - 1)}
                    value={layerIndex}
                    onChange={(e) => setLayerIndex(Number(e.target.value))}
                    aria-label="Layer"
                  />
                  <div className="row">
                    <span className="faint">
                      Layer {layerIndex + 1} of {outcome.stats.layerCount}
                    </span>
                    <span className="spacer" />
                    <span className="faint">z = {outcome.preview.printZ[layerIndex]?.toFixed(2)} mm</span>
                  </div>
                  <PathLegend />
                </div>

                <div className="card stack">
                  <h2>Send it to the printer</h2>
                  <p className="muted" style={{ margin: 0 }}>
                    Save the file to a USB stick, put it in the printer and choose it from the print menu.
                  </p>
                  <div className="row wrap">
                    <button className="btn primary" onClick={() => exportFile('gcode')}>
                      ⤓ .gcode
                    </button>
                    <button className="btn" onClick={() => exportFile('g')}>
                      ⤓ .g
                    </button>
                    <button className="btn ghost" onClick={() => exportFile('gx')}>
                      ⤓ .gx
                    </button>
                  </div>
                  <div className="faint">
                    <strong>.gcode</strong> and <strong>.g</strong> hold identical text — use <strong>.g</strong> if
                    your printer's menu ignores <code>.gcode</code>. <strong>.gx</strong> wraps the same G-code in
                    FlashPrint's container with a thumbnail; the format is community-documented rather than official,
                    so treat it as the fallback rather than the first thing to try.
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>
      {progress && <ProgressOverlay fraction={progress.fraction} label={progress.label} />}
    </>
  );
}

function AdvancedSettings({
  settings,
  onChange,
}: {
  settings: PrintSettings;
  onChange: (changes: Partial<PrintSettings>) => void;
}) {
  return (
    <details className="card settings">
      <summary>Speeds, adhesion and retraction</summary>
      <div className="body">
        <Slider label="Perimeter speed" value={settings.perimeterSpeed} min={10} max={150} suffix=" mm/s" onChange={(v) => onChange({ perimeterSpeed: v })} />
        <Slider label="Outer wall speed" value={settings.externalPerimeterSpeed} min={5} max={120} suffix=" mm/s" onChange={(v) => onChange({ externalPerimeterSpeed: v })} />
        <Slider label="Infill speed" value={settings.infillSpeed} min={10} max={200} suffix=" mm/s" onChange={(v) => onChange({ infillSpeed: v })} />
        <Slider label="First layer speed" value={settings.firstLayerSpeed} min={5} max={60} suffix=" mm/s" onChange={(v) => onChange({ firstLayerSpeed: v })} hint="Slow first layers stick better than fast ones." />
        <Slider label="Travel speed" value={settings.travelSpeed} min={30} max={300} suffix=" mm/s" onChange={(v) => onChange({ travelSpeed: v })} />

        <ToggleGroup<InfillPattern>
          label="Infill pattern"
          value={settings.infillPattern}
          options={[
            { value: 'rectilinear', label: 'Lines' },
            { value: 'grid', label: 'Grid' },
            { value: 'concentric', label: 'Concentric' },
          ]}
          onChange={(v) => onChange({ infillPattern: v })}
        />

        <Slider label="Top layers" value={settings.topLayers} min={0} max={10} onChange={(v) => onChange({ topLayers: v })} />
        <Slider label="Bottom layers" value={settings.bottomLayers} min={0} max={10} onChange={(v) => onChange({ bottomLayers: v })} />
        <Slider label="Skirt loops" value={settings.skirtLoops} min={0} max={5} onChange={(v) => onChange({ skirtLoops: v })} />
        <Slider label="Brim width" value={settings.brimWidth} min={0} max={12} suffix=" mm" onChange={(v) => onChange({ brimWidth: v })} hint="A brim helps tall or narrow prints stay put." />
        {settings.supports && (
          <>
            <Slider
              label="Support overhang angle"
              value={settings.supportOverhangAngle}
              min={20}
              max={70}
              suffix="°"
              onChange={(v) => onChange({ supportOverhangAngle: v })}
              hint="Measured from vertical. Higher means the printer is trusted with more, so less support is built."
            />
            <Slider label="Support density" value={settings.supportDensity} min={5} max={40} suffix="%" onChange={(v) => onChange({ supportDensity: v })} />
            <Slider label="Support gap under the model" value={settings.supportZGap} min={0} max={0.6} step={0.05} suffix=" mm" onChange={(v) => onChange({ supportZGap: v })} hint="A gap makes support snap off; too much and the overhang droops." />
          </>
        )}

        <Slider label="Retraction" value={settings.retractionMm} min={0} max={6} step={0.1} suffix=" mm" onChange={(v) => onChange({ retractionMm: v })} />
        <Slider label="Z hop" value={settings.zHop} min={0} max={1} step={0.1} suffix=" mm" onChange={(v) => onChange({ zHop: v })} />
        <Slider label="Extrusion width" value={settings.extrusionWidth} min={0.3} max={0.8} step={0.02} suffix=" mm" onChange={(v) => onChange({ extrusionWidth: v })} />
        <Slider label="Flow" value={Math.round(settings.flow * 100)} min={80} max={120} suffix="%" onChange={(v) => onChange({ flow: v / 100 })} />
      </div>
    </details>
  );
}

/** Render the middle of the print into the 80x60 RGB thumbnail a .gx expects. */
function renderThumbnail(preview: PreviewData): Uint8Array {
  const { width, height } = THUMBNAIL_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, width, height);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < preview.points.length; i += 2) {
    minX = Math.min(minX, preview.points[i]);
    maxX = Math.max(maxX, preview.points[i]);
    minY = Math.min(minY, preview.points[i + 1]);
    maxY = Math.max(maxY, preview.points[i + 1]);
  }
  if (isFinite(minX)) {
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const scale = (Math.min(width, height) - 8) / span;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Draw a spread of layers so the thumbnail reads as a solid object.
    const layers = preview.printZ.length;
    for (let step = 0; step < 12; step++) {
      const index = Math.min(layers - 1, Math.round((step / 11) * (layers - 1)));
      ctx.globalAlpha = 0.25 + (step / 11) * 0.6;
      const from = preview.layerStart[index];
      const to = preview.layerStart[index + 1];
      for (let p = from; p < to; p++) {
        if (preview.pathKind[p] > 1) continue; // walls only, for a clean outline
        ctx.strokeStyle = PATH_COLOURS[PATH_KINDS[preview.pathKind[p]]];
        ctx.lineWidth = 1;
        const start = preview.pathStart[p];
        const end = preview.pathStart[p + 1];
        if (end - start < 2) continue;
        ctx.beginPath();
        for (let v = start; v < end; v++) {
          const x = width / 2 + (preview.points[v * 2] - cx) * scale;
          const y = height / 2 - (preview.points[v * 2 + 1] - cy) * scale;
          if (v === start) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  const data = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return rgb;
}
