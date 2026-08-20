import { useMemo, useRef, useState } from 'react';
import {
  deleteModel,
  deletePhoto,
  deletePhotosForProject,
  getProject,
  listModels,
  listPhotos,
  newId,
  saveModel,
  saveProject,
  type ModelRecord,
  type Photo,
  type Project,
} from '../lib/db';
import { addPhotos, respaceAngles } from '../lib/photos';
import { DEFAULT_WORK_SIZE, loadRaster } from '../lib/image';
import { DEFAULT_CARVE_OPTIONS } from '../lib/carve';
import { DEFAULT_HEIGHTFIELD_OPTIONS, type HeightfieldMode } from '../lib/heightfield';
import { fitToPrintVolume, meshBounds, triangleCount, yUpToZUp, type Mesh } from '../lib/mesh';
import { meshToBinarySTL, downloadBlob, safeFilename } from '../lib/stl';
import { shareFiles } from '../lib/share';
import { formatDuration } from '../lib/slicer/gcode';
import { heightfield as buildHeightfieldJob, reconstruct } from '../lib/reconClient';
import { useNavigate } from '../lib/useHashRoute';
import { AppBar, ProgressOverlay, Slider, ToggleGroup, formatBytes, relativeTime, useAsync, useNow, useObjectUrl, useToast } from './ui';
import { CaptureMeter } from './CaptureMeter';
import { MINIMUM_FOR_3D } from '../lib/captureGuide';
import { ModelViewer } from './ModelViewer';

const DETAIL_LEVELS = [
  { value: 96, label: 'Draft' },
  { value: 128, label: 'Standard' },
  { value: 160, label: 'High' },
  { value: 200, label: 'Max' },
];

export function ProjectView({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const notify = useToast();
  const now = useNow();
  const fileRef = useRef<HTMLInputElement>(null);

  const { value: project, reload: reloadProject } = useAsync(() => getProject(projectId), [projectId]);
  const { value: photos, reload: reloadPhotos } = useAsync(() => listPhotos(projectId), [projectId]);
  const { value: models, reload: reloadModels } = useAsync(() => listModels(projectId), [projectId]);

  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [result, setResult] = useState<{ mesh: Mesh; triangles: number; size: [number, number, number] } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);

  const usable = useMemo(() => (photos ?? []).filter((p) => !p.excluded), [photos]);
  const isRelief = project?.mode === 'relief';

  const patch = async (changes: Partial<Project>) => {
    if (!project) return;
    await saveProject({ ...project, ...changes });
    reloadProject();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !project) return;
    setProgress({ fraction: 0.1, label: 'Importing photos' });
    try {
      await addPhotos(projectId, Array.from(files), project.sweepDeg);
      reloadPhotos();
      notify(`${files.length} photo${files.length === 1 ? '' : 's'} added`);
    } catch {
      notify('Could not read one of those files');
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePhoto = async (photo: Photo) => {
    if (!project) return;
    await deletePhoto(photo.id);
    await respaceAngles(projectId, project.sweepDeg);
    reloadPhotos();
  };

  const build = async () => {
    if (!project) return;
    setResult(null);
    setWarnings([]);
    setProgress({ fraction: 0, label: 'Preparing photos' });
    const carveOpts = { ...DEFAULT_CARVE_OPTIONS, ...project.carve };

    try {
      let mesh: Mesh;
      const notes: string[] = [];

      if (isRelief) {
        const source = usable[0];
        if (!source) {
          notify('Add a photo first');
          setProgress(null);
          return;
        }
        const raster = await loadRaster(source.blob, 900);
        const hf = { ...DEFAULT_HEIGHTFIELD_OPTIONS, ...project.heightfield };
        const job = await buildHeightfieldJob(
          raster,
          hf,
          hf.mode !== 'lithophane',
          { ...project.segment, ...source.segment },
          source.paint,
          setProgress,
        );
        mesh = job.mesh;
      } else {
        if (usable.length < 2) {
          notify('A 3D scan needs at least 2 photos');
          setProgress(null);
          return;
        }
        setProgress({ fraction: 0.02, label: 'Reading photos' });
        const views = [];
        const unreadable: number[] = [];
        for (const photo of usable) {
          let raster;
          try {
            raster = await loadRaster(photo.blob, DEFAULT_WORK_SIZE);
          } catch {
            // One damaged photo should not cost the user the whole carve.
            unreadable.push(photo.angleDeg);
            continue;
          }
          views.push({
            image: raster,
            angleDeg: photo.angleDeg,
            options: { ...project.segment, ...photo.segment },
            paint: photo.paint,
          });
        }
        if (unreadable.length > 0) {
          notes.push(
            `${unreadable.length} photo${unreadable.length === 1 ? '' : 's'} could not be read (at ${unreadable
              .map((a) => `${Math.round(a)}°`)
              .join(', ')}) and ${unreadable.length === 1 ? 'was' : 'were'} skipped. Delete ${
              unreadable.length === 1 ? 'it' : 'them'
            } and add ${unreadable.length === 1 ? 'it' : 'them'} again from your gallery.`,
          );
        }
        if (views.length < 2) {
          notify('Not enough readable photos to carve. Re-add them from your gallery.');
          setProgress(null);
          return;
        }
        const job = await reconstruct(views, carveOpts, setProgress);
        mesh = job.mesh;

        if (import.meta.env.DEV) console.table(job.diagnostics);

        const bad = job.diagnostics.filter((d) => !d.hasSilhouette);
        if (bad.length > 0) {
          notes.push(
            `${bad.length} photo${bad.length === 1 ? '' : 's'} had no usable outline and ${bad.length === 1 ? 'was' : 'were'} skipped (at ${bad
              .map((d) => `${Math.round(d.angleDeg)}°`)
              .join(', ')}). Open ${bad.length === 1 ? 'it' : 'them'} and paint the outline in.`,
          );
        }
        const huge = job.diagnostics.filter((d) => d.coverage > 0.75);
        if (huge.length > 0) {
          notes.push(`${huge.length} outline${huge.length === 1 ? '' : 's'} covered most of the frame — check the background separation.`);
        }
        // A silhouette much taller or shorter than the rest usually means a
        // shadow or a stray object got swept into that outline.
        const odd = job.diagnostics.filter((d) => d.hasSilhouette && Math.abs(d.heightRatio - 1) > 0.2);
        if (odd.length > 0) {
          notes.push(
            `${odd.length} outline${odd.length === 1 ? ' is' : 's are'} a very different height from the rest (at ${odd
              .map((d) => `${Math.round(d.angleDeg)}°`)
              .join(', ')}). Open ${odd.length === 1 ? 'it' : 'them'} and check for shadows or clutter in the outline.`,
          );
        }
      }

      if (mesh.indices.length === 0) {
        /*
         * The carve is an intersection: a voxel has to sit inside the silhouette
         * of every view to survive. An empty result means no point in space was
         * inside all of them at once — so the diagnostics collected above are
         * exactly what the user needs, and dropping them (as this used to) left
         * them with nothing to act on.
         */
        setWarnings([
          'Nothing was left after carving. A voxel only survives if it lands inside the outline in every photo, so one bad outline — or photos that were not really shot at the angles the app assumed — can erase the whole model.',
          ...notes,
          ...(notes.length === 0
            ? [
                'Every outline looked reasonable on its own, which points at the angles. The app assumes the photos are one even rotation, in order, all the way around. Mixing two sets — a gallery import plus a camera session, or two different objects — breaks that assumption.',
              ]
            : []),
          `Tolerance is ${carveOpts.tolerance}, so ${
            carveOpts.tolerance === 0 ? 'a single disagreeing photo removes everything' : `up to ${carveOpts.tolerance} photos may disagree`
          }. Raising it lets an imperfect outline through.`,
        ]);
        notify('Nothing was left after carving');
        setProgress(null);
        return;
      }

      const scaled = isRelief ? mesh : fitToPrintVolume(mesh, project.targetSizeMm);
      const b = meshBounds(scaled);
      setResult({
        mesh: scaled,
        triangles: triangleCount(scaled),
        size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
      });
      setWarnings(notes);
      notify('Model ready');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Reconstruction failed');
    } finally {
      setProgress(null);
    }
  };

  const saveResult = async () => {
    if (!result || !project) return;
    const printable = yUpToZUp(result.mesh);
    const stl = new Blob([meshToBinarySTL(printable, `${project.name} - 3dPrintMaster`)], {
      type: 'model/stl',
    });
    const index = (models?.length ?? 0) + 1;
    const record: ModelRecord = {
      id: newId('mdl'),
      projectId,
      name: `${project.name} v${index}`,
      createdAt: Date.now(),
      stl,
      triangles: result.triangles,
      sizeMm: [result.size[0], result.size[2], result.size[1]],
      method: isRelief ? `relief (${project.heightfield.mode ?? DEFAULT_HEIGHTFIELD_OPTIONS.mode})` : `visual hull, ${usable.length} views`,
      photoCount: usable.length,
      params: isRelief ? { ...project.heightfield } : { ...project.carve, targetSizeMm: project.targetSizeMm },
    };
    await saveModel(record);

    /*
     * The photos have done their job. They are the bulk of a project on disk —
     * a 24-shot set is tens of megabytes against a couple for the STL — and
     * what gets printed from here on is the model and its G-code. Clearing them
     * is one-way, so `keepPhotos` opts out for anyone still iterating on the
     * carve settings.
     */
    if (project.keepPhotos) {
      reloadModels();
      notify('Saved to project');
      return;
    }
    const cleared = await deletePhotosForProject(projectId);
    reloadPhotos();
    reloadModels();
    setResult(null);
    setWarnings([]);
    notify(cleared > 0 ? `Saved — ${cleared} photo${cleared === 1 ? '' : 's'} cleared` : 'Saved to project');
  };

  if (!project) {
    return (
      <>
        <AppBar title="Project" onBack={() => navigate('')} />
        <main>
          <div className="muted">Loading…</div>
        </main>
      </>
    );
  }

  const carve = { ...DEFAULT_CARVE_OPTIONS, ...project.carve };
  const hf = { ...DEFAULT_HEIGHTFIELD_OPTIONS, ...project.heightfield };

  return (
    <>
      <AppBar
        title={project.name}
        subtitle={isRelief ? 'relief project' : 'scan project'}
        onBack={() => navigate('')}
        actions={
          <button className="btn ghost icon" onClick={() => setRenaming((r) => !r)} aria-label="Rename">
            ✎
          </button>
        }
      />
      <main className="stack">
        {renaming && (
          <div className="card stack">
            <div>
              <label className="field" htmlFor="rename">
                Project name
              </label>
              <input
                id="rename"
                type="text"
                defaultValue={project.name}
                onBlur={(e) => void patch({ name: e.target.value.trim() || project.name })}
              />
            </div>
            <div>
              <label className="field" htmlFor="notes">
                Notes
              </label>
              <textarea id="notes" defaultValue={project.notes} onBlur={(e) => void patch({ notes: e.target.value })} />
            </div>
            <button className="btn" onClick={() => setRenaming(false)}>
              Done
            </button>
          </div>
        )}

        {!isRelief && <CaptureMeter photoCount={usable.length} />}

        <div className="card stack">
          <div className="row">
            <h2>Photos</h2>
            <span className="spacer" />
            <span className="faint">{usable.length} in use</span>
          </div>

          <div className="grid-photos">
            {(photos ?? []).map((photo) => (
              <PhotoTile
                key={photo.id}
                photo={photo}
                onOpen={() => navigate(`p/${projectId}/photo/${photo.id}`)}
                onDelete={() => void removePhoto(photo)}
                showAngle={!isRelief}
              />
            ))}
            <button className="photo-tile add" onClick={() => fileRef.current?.click()}>
              <span style={{ fontSize: '1.3rem' }}>+</span>
              <span>Add photos</span>
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => void onFiles(e.target.files)}
          />

          <div className="row wrap">
            <button className="btn" onClick={() => navigate(`p/${projectId}/capture`)}>
              📷 Scan with camera
            </button>
            {!isRelief && (photos?.length ?? 0) > 1 && (
              <button
                className="btn ghost small"
                onClick={async () => {
                  await respaceAngles(projectId, project.sweepDeg);
                  reloadPhotos();
                  notify('Angles spaced evenly');
                }}
              >
                Re-space angles
              </button>
            )}
          </div>
        </div>

        {isRelief ? (
          <ReliefSettings
            mode={hf.mode}
            sizeMm={hf.sizeMm}
            baseMm={hf.baseMm}
            reliefMm={hf.reliefMm}
            smooth={hf.smooth}
            invert={hf.invert}
            onChange={(changes) => void patch({ heightfield: { ...project.heightfield, ...changes } })}
          />
        ) : (
          <ScanSettings
            project={project}
            resolution={carve.resolution}
            elevationDeg={carve.elevationDeg}
            tolerance={carve.tolerance}
            alignment={carve.alignment}
            smoothIterations={carve.smoothIterations}
            flatBase={carve.flatBase}
            onCarveChange={(changes) => void patch({ carve: { ...project.carve, ...changes } })}
            onProjectChange={(changes) => void patch(changes)}
            onSweepChange={async (sweepDeg) => {
              await patch({ sweepDeg });
              await respaceAngles(projectId, sweepDeg);
              reloadPhotos();
            }}
          />
        )}

        <button
          className="btn primary block"
          onClick={build}
          disabled={!!progress || usable.length === 0 || (!isRelief && usable.length < 2)}
        >
          {isRelief ? 'Build relief' : `Carve 3D model from ${usable.length} photos`}
        </button>

        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={!project.keepPhotos}
            onChange={(e) => void patch({ keepPhotos: !e.target.checked })}
          />
          <span className="faint">
            Clear the photos once a model is saved, leaving just the STL and its printable file. Uncheck this while
            you are still adjusting the carve — clearing cannot be undone.
          </span>
        </label>

        {!isRelief && usable.length > 0 && usable.length < MINIMUM_FOR_3D && (
          <div className="callout warn">
            You can build with {usable.length}, but expect flat facets. {MINIMUM_FOR_3D} photos is the minimum for a
            result worth printing.
          </div>
        )}

        {warnings.length > 0 && (
          <div className="stack">
            {warnings.map((w) => (
              <div className="callout warn" key={w}>
                {w}
              </div>
            ))}
          </div>
        )}

        {result && (
          <div className="card stack">
            <div className="row">
              <h2>Result</h2>
              <span className="spacer" />
              <span className="chip">{result.triangles.toLocaleString()} triangles</span>
            </div>
            <ModelViewer mesh={result.mesh} hint="drag to rotate · pinch to zoom" />
            <div className="faint">
              Print size {result.size[0].toFixed(1)} × {result.size[2].toFixed(1)} × {result.size[1].toFixed(1)} mm
              (W × D × H). The STL is exported Z-up, standing on the bed.
            </div>
            <div className="faint">
              Save it to the project, then hit <strong>Slice</strong> on it to make a file your FlashForge can print.
            </div>
            <div className="row">
              <button className="btn primary" onClick={saveResult}>
                Save to project
              </button>
              <span className="spacer" />
              <button
                className="btn"
                onClick={() => {
                  const stl = meshToBinarySTL(yUpToZUp(result.mesh), project.name);
                  downloadBlob(new Blob([stl], { type: 'model/stl' }), `${safeFilename(project.name)}.stl`);
                }}
              >
                ⤓ STL
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const stl = meshToBinarySTL(yUpToZUp(result.mesh), project.name);
                  const file = {
                    blob: new Blob([stl], { type: 'model/stl' }),
                    filename: `${safeFilename(project.name)}.stl`,
                  };
                  const how = await shareFiles([file], project.name, 'STL from 3dPrintMaster');
                  if (how === 'downloaded') notify('Sharing is not available here — downloaded instead');
                }}
              >
                Share
              </button>
            </div>
          </div>
        )}

        {models && models.length > 0 && (
          <div className="card stack">
            <h2>Saved models</h2>
            <div className="list-divide">
              {models.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  now={now}
                  onSlice={() => navigate(`p/${projectId}/slice/${model.id}`)}
                  onDelete={async () => {
                    await deleteModel(model.id);
                    reloadModels();
                  }}
                  onShareFallback={() => notify('Sharing is not available here — downloaded instead')}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {progress && <ProgressOverlay fraction={progress.fraction} label={progress.label} />}
    </>
  );
}

function PhotoTile({
  photo,
  onOpen,
  onDelete,
  showAngle,
}: {
  photo: Photo;
  onOpen: () => void;
  onDelete: () => void;
  showAngle: boolean;
}) {
  const url = useObjectUrl(photo.thumb);
  return (
    <div className={`photo-tile ${photo.excluded ? 'excluded' : ''}`}>
      <button onClick={onOpen} style={{ all: 'unset', display: 'block', width: '100%', height: '100%' }}>
        {url && <img src={url} alt="" />}
      </button>
      {showAngle && <span className="angle">{Math.round(photo.angleDeg)}°</span>}
      <button
        className="badge"
        onClick={onDelete}
        aria-label="Remove photo"
        style={{ border: 'none', color: 'var(--bad)' }}
      >
        ✕
      </button>
    </div>
  );
}

function ScanSettings({
  project,
  resolution,
  elevationDeg,
  tolerance,
  alignment,
  smoothIterations,
  flatBase,
  onCarveChange,
  onProjectChange,
  onSweepChange,
}: {
  project: Project;
  resolution: number;
  elevationDeg: number;
  tolerance: number;
  alignment: 'consistent' | 'per-view';
  smoothIterations: number;
  flatBase: boolean;
  onCarveChange: (changes: Record<string, unknown>) => void;
  onProjectChange: (changes: Partial<Project>) => void;
  onSweepChange: (sweepDeg: number) => void;
}) {
  return (
    <details className="card settings">
      <summary>Model settings</summary>
      <div className="body">
        <ToggleGroup
          label="Detail"
          value={String(resolution)}
          options={DETAIL_LEVELS.map((d) => ({ value: String(d.value), label: d.label }))}
          onChange={(v) => onCarveChange({ resolution: Number(v) })}
        />
        <div className="faint">Higher detail takes longer and produces a heavier STL. Standard suits most objects.</div>

        <ToggleGroup
          label="How far you went around"
          value={String(project.sweepDeg)}
          options={[
            { value: '360', label: 'Full turn' },
            { value: '180', label: 'Half turn' },
          ]}
          onChange={(v) => onSweepChange(Number(v))}
        />

        <Slider
          label="Finished size (longest edge)"
          value={project.targetSizeMm}
          min={10}
          max={250}
          step={5}
          suffix=" mm"
          onChange={(v) => onProjectChange({ targetSizeMm: v })}
        />
        <Slider
          label="Camera tilt below level"
          value={elevationDeg}
          min={0}
          max={45}
          suffix="°"
          onChange={(v) => onCarveChange({ elevationDeg: v })}
          hint="0 if you shot level with the middle of the object. Raise it if you shot down onto it."
        />
        <Slider
          label="Ignore bad outlines"
          value={tolerance}
          min={0}
          max={3}
          suffix=" photos"
          onChange={(v) => onCarveChange({ tolerance: v })}
          hint="Lets a few mistaken silhouettes be outvoted instead of gouging the model."
        />
        <ToggleGroup<'consistent' | 'per-view'>
          label="Distance to the object"
          value={alignment}
          options={[
            { value: 'consistent', label: 'Stayed put' },
            { value: 'per-view', label: 'Moved about' },
          ]}
          onChange={(v) => onCarveChange({ alignment: v })}
        />
        <div className="faint">
          “Stayed put” sizes every photo the same way, which is right for a turntable and shrugs off one bad outline.
          Pick “Moved about” only if you walked around the object and changed your distance to it.
        </div>

        <Slider
          label="Smoothing"
          value={smoothIterations}
          min={0}
          max={8}
          onChange={(v) => onCarveChange({ smoothIterations: v })}
        />
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={flatBase}
            style={{ width: 20, height: 20, minHeight: 0 }}
            onChange={(e) => onCarveChange({ flatBase: e.target.checked })}
          />
          <span>Flatten the bottom so it stands on the bed</span>
        </label>
      </div>
    </details>
  );
}

function ReliefSettings({
  mode,
  sizeMm,
  baseMm,
  reliefMm,
  smooth,
  invert,
  onChange,
}: {
  mode: HeightfieldMode;
  sizeMm: number;
  baseMm: number;
  reliefMm: number;
  smooth: number;
  invert: boolean;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  return (
    <details className="card settings" open>
      <summary>Relief settings</summary>
      <div className="body">
        <ToggleGroup<HeightfieldMode>
          label="Style"
          value={mode}
          options={[
            { value: 'relief', label: 'Relief' },
            { value: 'lithophane', label: 'Lithophane' },
            { value: 'stamp', label: 'Cut-out' },
          ]}
          onChange={(v) => onChange({ mode: v })}
        />
        <div className="faint">
          {mode === 'relief'
            ? 'Bright areas rise, dark areas stay low, and the background is cut away.'
            : mode === 'lithophane'
              ? 'A flat panel that is thick where the photo is dark — hold it up to a light to see the picture.'
              : 'A flat plate in the outline of the object, like a cookie cutter or a badge.'}
        </div>
        <Slider label="Size (longest edge)" value={sizeMm} min={20} max={250} step={5} suffix=" mm" onChange={(v) => onChange({ sizeMm: v })} />
        <Slider label="Base thickness" value={baseMm} min={0.5} max={8} step={0.5} suffix=" mm" onChange={(v) => onChange({ baseMm: v })} />
        <Slider
          label={mode === 'lithophane' ? 'Image thickness range' : 'Relief height'}
          value={reliefMm}
          min={0.5}
          max={20}
          step={0.5}
          suffix=" mm"
          onChange={(v) => onChange({ reliefMm: v })}
        />
        <Slider label="Smoothing" value={smooth} min={0} max={8} onChange={(v) => onChange({ smooth: v })} />
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={invert}
            style={{ width: 20, height: 20, minHeight: 0 }}
            onChange={(e) => onChange({ invert: e.target.checked })}
          />
          <span>Invert light and dark</span>
        </label>
      </div>
    </details>
  );
}

function ModelRow({
  model,
  now,
  onSlice,
  onDelete,
  onShareFallback,
}: {
  model: ModelRecord;
  now: number;
  onSlice: () => void;
  onDelete: () => void;
  onShareFallback: () => void;
}) {
  const base = safeFilename(model.name);
  const sliced = model.slice;
  // Everything the printer needs, in one place: the model and, once it has been
  // sliced, the file that actually goes on the machine.
  const files = [
    { blob: model.stl, filename: `${base}.stl` },
    ...(sliced ? [{ blob: sliced.gcode, filename: `${base}.gcode` }] : []),
  ];

  return (
    <div className="row wrap" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 160 }}>
        <strong>{model.name}</strong>
        <div className="faint">
          {model.triangles.toLocaleString()} triangles · {formatBytes(model.stl.size)} ·{' '}
          {model.sizeMm.map((n) => n.toFixed(0)).join(' × ')} mm
        </div>
        <div className="faint">
          {model.method} · {relativeTime(model.createdAt, now)}
        </div>
        {sliced && (
          <div className="faint">
            ✓ sliced · {sliced.layerCount} layers · {formatDuration(sliced.estimatedSeconds)} ·{' '}
            {formatBytes(sliced.gcode.size)} of G-code
          </div>
        )}
      </div>
      <button className="btn small primary" onClick={onSlice}>
        {sliced ? 'Re-slice' : 'Slice'}
      </button>
      <button className="btn small" onClick={() => downloadBlob(model.stl, `${base}.stl`)}>
        ⤓ STL
      </button>
      {sliced && (
        <button className="btn small" onClick={() => downloadBlob(sliced.gcode, `${base}.gcode`)}>
          ⤓ G-code
        </button>
      )}
      <button
        className="btn small"
        onClick={async () => {
          const how = await shareFiles(files, model.name, sliced ? 'STL and G-code from 3dPrintMaster' : 'STL from 3dPrintMaster');
          if (how === 'downloaded') onShareFallback();
        }}
      >
        Share
      </button>
      <button className="btn small ghost danger" onClick={onDelete} aria-label="Delete model">
        ✕
      </button>
    </div>
  );
}
