import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deletePhoto, getProject, listPhotos, savePhoto, saveProject, type Photo, type Project } from '../lib/db';
import { loadRaster, DEFAULT_WORK_SIZE, type RasterImage } from '../lib/image';
import { DEFAULT_SEGMENT_OPTIONS, type SegmentOptions } from '../lib/segment';
import { segmentPreview, type SegmentPreview } from '../lib/reconClient';
import { useNavigate } from '../lib/useHashRoute';
import { AppBar, Slider, ToggleGroup, useToast } from './ui';

type Tool = 'pan' | 'keep' | 'remove' | 'pick';

/**
 * Per-photo silhouette editor. Automatic segmentation gets it right most of the
 * time; when it does not, painting two or three strokes fixes the carve far
 * faster than reshooting.
 */
export function MaskEditor({ projectId, photoId }: { projectId: string; photoId: string }) {
  const navigate = useNavigate();
  const notify = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [raster, setRaster] = useState<RasterImage | null>(null);
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>('pan');
  const [brush, setBrush] = useState(24);
  const [overrides, setOverrides] = useState<Partial<SegmentOptions>>({});
  const [angle, setAngle] = useState(0);

  const paintRef = useRef<Uint8Array | null>(null);
  const undoRef = useRef<Uint8Array[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);

  const options: Partial<SegmentOptions> = useMemo(
    () => ({ ...DEFAULT_SEGMENT_OPTIONS, ...project?.segment, ...overrides }),
    [project, overrides],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prj, photos] = await Promise.all([getProject(projectId), listPhotos(projectId)]);
      const found = photos.find((p) => p.id === photoId) ?? null;
      if (cancelled || !found) return;
      setProject(prj ?? null);
      setPhoto(found);
      setOverrides(found.segment ?? {});
      setAngle(found.angleDeg);
      const r = await loadRaster(found.blob, DEFAULT_WORK_SIZE);
      if (cancelled) return;
      setRaster(r);
      paintRef.current =
        found.paint && found.paint.width === r.width && found.paint.height === r.height
          ? new Uint8Array(found.paint.data)
          : new Uint8Array(r.width * r.height);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, photoId]);

  const runSegment = useCallback(async () => {
    if (!raster) return;
    setBusy(true);
    try {
      const result = await segmentPreview(
        raster,
        options,
        paintRef.current
          ? { width: raster.width, height: raster.height, data: paintRef.current }
          : undefined,
      );
      setPreview(result);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not read that photo');
    } finally {
      setBusy(false);
    }
  }, [raster, options, notify]);

  useEffect(() => {
    const timer = setTimeout(runSegment, 160);
    return () => clearTimeout(timer);
  }, [runSegment]);

  // Composite the photo with the silhouette tint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !raster) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);

    if (!preview) return;
    const layer = ctx.createImageData(raster.width, raster.height);
    const d = layer.data;
    const mask = preview.mask;
    const paint = paintRef.current;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const i = y * raster.width + x;
        const j = i * 4;
        const on = mask[i] > 0;
        const edge =
          on &&
          (x === 0 ||
            y === 0 ||
            x === raster.width - 1 ||
            y === raster.height - 1 ||
            !mask[i - 1] ||
            !mask[i + 1] ||
            !mask[i - raster.width] ||
            !mask[i + raster.width]);
        if (edge) {
          d[j] = 250;
          d[j + 1] = 204;
          d[j + 2] = 21;
          d[j + 3] = 255;
        } else if (!on) {
          // Dim everything the carve will treat as background.
          d[j] = 4;
          d[j + 1] = 8;
          d[j + 2] = 20;
          d[j + 3] = 150;
        }
        if (paint && paint[i]) {
          d[j] = paint[i] === 1 ? 88 : 242;
          d[j + 1] = paint[i] === 1 ? 217 : 102;
          d[j + 2] = paint[i] === 1 ? 153 : 111;
          d[j + 3] = 120;
        }
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = raster.width;
    tmp.height = raster.height;
    tmp.getContext('2d')!.putImageData(layer, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }, [raster, preview]);

  const persist = useCallback(
    async (patch: Partial<Photo>) => {
      if (!photo) return;
      const next: Photo = {
        ...photo,
        ...patch,
        segment: patch.segment ?? overrides,
        paint:
          paintRef.current && raster
            ? { width: raster.width, height: raster.height, data: new Uint8Array(paintRef.current) }
            : undefined,
      };
      setPhoto(next);
      await savePhoto(next);
      if (project) await saveProject(project);
    },
    [photo, overrides, raster, project],
  );

  // Save pending edits when leaving.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void persist({});
    };
  }, [persist]);

  const toRasterCoords = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * canvas.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * canvas.height),
    };
  };

  const stamp = (cx: number, cy: number) => {
    const paint = paintRef.current;
    if (!paint || !raster) return;
    const value = tool === 'keep' ? 1 : 2;
    const r = brush;
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(raster.height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(raster.width - 1, cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) paint[y * raster.width + x] = value;
      }
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!raster) return;
    const { x, y } = toRasterCoords(event);

    if (tool === 'pick') {
      const i = (y * raster.width + x) * 4;
      const sample: [number, number, number] = [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
      const existing = options.bgSamples ?? [];
      setOverrides((o) => ({ ...o, bgSamples: [...existing, sample].slice(-6) }));
      dirtyRef.current = true;
      notify('Background colour sampled');
      return;
    }
    if (tool === 'pan') return;

    if (paintRef.current) {
      undoRef.current.push(new Uint8Array(paintRef.current));
      if (undoRef.current.length > 12) undoRef.current.shift();
    }
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    stamp(x, y);
    dirtyRef.current = true;
    void runSegment();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const { x, y } = toRasterCoords(event);
    stamp(x, y);
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    void runSegment();
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) {
      notify('Nothing to undo');
      return;
    }
    paintRef.current = prev;
    dirtyRef.current = true;
    void runSegment();
  };

  const resetEdits = () => {
    if (raster) paintRef.current = new Uint8Array(raster.width * raster.height);
    undoRef.current = [];
    setOverrides({});
    dirtyRef.current = true;
    void runSegment();
  };

  const removePhoto = async () => {
    if (!confirm('Delete this photo?')) return;
    dirtyRef.current = false;
    await deletePhoto(photoId);
    notify('Photo deleted');
    navigate(`p/${projectId}`);
  };

  const coverage = preview?.coverage ?? 0;
  const coverageState = coverage < 0.01 ? 'bad' : coverage > 0.75 ? 'warn' : 'good';

  return (
    <>
      <AppBar
        title="Outline"
        subtitle={photo ? `photo at ${Math.round(angle)}°` : 'photo'}
        onBack={() => {
          if (dirtyRef.current) void persist({});
          navigate(`p/${projectId}`);
        }}
        actions={
          <button className="btn ghost icon danger" onClick={removePhoto} aria-label="Delete photo">
            ✕
          </button>
        }
      />
      <main className="stack">
        <div className="editor-canvas-wrap">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        <div className="row wrap">
          <span className={`chip ${coverageState}`}>
            {coverage < 0.01
              ? 'No outline found'
              : `Object fills ${(coverage * 100).toFixed(0)}% of frame`}
          </span>
          {busy && <span className="chip">working…</span>}
          <span className="spacer" />
          <button className="btn small ghost" onClick={undo}>
            Undo
          </button>
          <button className="btn small ghost" onClick={resetEdits}>
            Reset
          </button>
        </div>

        {coverage < 0.01 && (
          <div className="callout bad">
            Nothing was detected as the object. Tap <strong>Keep</strong> and paint over it, or use{' '}
            <strong>Pick background</strong> on the backdrop.
          </div>
        )}
        {coverage > 0.75 && (
          <div className="callout warn">
            Almost the whole frame is being treated as the object — usually the background is too similar to it. Lower
            “Include more”, or paint the background out.
          </div>
        )}

        <div className="card stack">
          <ToggleGroup<Tool>
            label="Tool"
            value={tool}
            onChange={setTool}
            options={[
              { value: 'pan', label: 'View' },
              { value: 'keep', label: 'Keep' },
              { value: 'remove', label: 'Erase' },
              { value: 'pick', label: 'Pick bg' },
            ]}
          />
          {(tool === 'keep' || tool === 'remove') && (
            <Slider label="Brush size" value={brush} min={4} max={80} onChange={setBrush} suffix=" px" />
          )}

          <Slider
            label="Include more of the object"
            value={Math.round((options.threshold ?? 0.12) * 100)}
            min={0}
            max={100}
            onChange={(v) => {
              setOverrides((o) => ({ ...o, threshold: v / 100 }));
              dirtyRef.current = true;
            }}
            hint="Raise it if parts of the object are being cut off; lower it if background is creeping in."
          />
          <Slider
            label="Cleanup"
            value={options.cleanup ?? 2}
            min={0}
            max={6}
            onChange={(v) => {
              setOverrides((o) => ({ ...o, cleanup: v }));
              dirtyRef.current = true;
            }}
            hint="Removes speckle and shadow fringes. Too much erodes fine detail."
          />

          <div>
            <label className="field" htmlFor="angle">
              Turntable angle for this shot
            </label>
            <input
              id="angle"
              type="number"
              value={angle}
              step={1}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAngle(v);
                dirtyRef.current = true;
                void persist({ angleDeg: v });
              }}
            />
            <div className="faint">
              Angles are spaced evenly when you add photos. Only change this if you shot uneven steps.
            </div>
          </div>

          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={!!photo?.excluded}
              style={{ width: 20, height: 20, minHeight: 0 }}
              onChange={(e) => void persist({ excluded: e.target.checked })}
            />
            <span>Exclude this photo from the model</span>
          </label>
        </div>
      </main>
    </>
  );
}
