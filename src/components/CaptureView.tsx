import { useCallback, useEffect, useRef, useState } from 'react';
import { getProject, listPhotos, type Project } from '../lib/db';
import { addPhotos } from '../lib/photos';
import { canvasToBlob } from '../lib/image';
import { useNavigate } from '../lib/useHashRoute';
import { useToast } from './ui';
import { MINIMUM_FOR_3D, RECOMMENDED } from '../lib/captureGuide';

const TARGET_CHOICES = [8, 12, 16, 24, 36];

/**
 * Turntable capture. Rotating the object a fixed step between shots is the whole
 * trick, so the overlay counts the steps for you and can fire automatically on a
 * timer while you spin the plate.
 */
export function CaptureView({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const notify = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingRef = useRef<Blob[]>([]);

  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState(0);
  const [startCount, setStartCount] = useState(0);
  const [target, setTarget] = useState(RECOMMENDED);
  const [auto, setAuto] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prj, photos] = await Promise.all([getProject(projectId), listPhotos(projectId)]);
      if (cancelled) return;
      setProject(prj ?? null);
      setStartCount(photos.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch (err) {
        setError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Camera permission was declined. You can still add photos from your gallery.'
            : 'No camera available on this device. Use “Add from gallery” instead.',
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
    pendingRef.current.push(blob);
    setCaptured((c) => c + 1);
  }, []);

  // Auto-capture timer: a beat to rotate, then a shot.
  useEffect(() => {
    if (!auto) {
      setCountdown(0);
      return;
    }
    if (captured >= target) {
      setAuto(false);
      return;
    }
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          void shoot();
          return 3;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [auto, captured, target, shoot]);

  const finish = async () => {
    if (pendingRef.current.length === 0) {
      navigate(`p/${projectId}`);
      return;
    }
    setSaving(true);
    try {
      await addPhotos(projectId, pendingRef.current, project?.sweepDeg ?? 360);
      notify(`${pendingRef.current.length} photo${pendingRef.current.length === 1 ? '' : 's'} added`);
      pendingRef.current = [];
      navigate(`p/${projectId}`);
    } catch {
      notify('Could not save those photos');
      setSaving(false);
    }
  };

  const total = startCount + captured;
  const step = target > 0 ? 360 / target : 0;
  const nextAngle = Math.round(captured * step);

  return (
    <div className="camera-shell">
      {error ? (
        <div className="empty-state" style={{ flex: 1, display: 'grid', placeContent: 'center' }}>
          <div className="big">📷</div>
          <p>{error}</p>
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <video ref={videoRef} playsInline muted style={{ height: '100%' }} />
          <div className="camera-overlay">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
              <ellipse cx="50" cy="66" rx="30" ry="10" fill="none" stroke="rgba(56,213,248,0.55)" strokeWidth="0.4" />
              <line x1="50" y1="12" x2="50" y2="88" stroke="rgba(255,255,255,0.16)" strokeWidth="0.25" />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: 'calc(env(safe-area-inset-top) + 12px)',
                left: 0,
                right: 0,
                textAlign: 'center',
                textShadow: '0 1px 6px rgba(0,0,0,0.8)',
              }}
            >
              <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>
                {captured} / {target}
              </div>
              <div style={{ fontSize: '0.82rem' }}>
                {captured >= target ? 'All the way round — tap Done' : `Rotate the object to ${nextAngle}°, then shoot`}
              </div>
              {auto && countdown > 0 && (
                <div style={{ fontSize: '2.4rem', fontWeight: 700, marginTop: 8 }}>{countdown}</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="camera-controls">
        <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
          {TARGET_CHOICES.map((n) => (
            <button
              key={n}
              className={`btn small ${n === target ? 'primary' : 'ghost'}`}
              onClick={() => setTarget(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="faint" style={{ textAlign: 'center' }}>
          {target < MINIMUM_FOR_3D
            ? `${target} shots is below the ${MINIMUM_FOR_3D} photo minimum for a 3D print.`
            : `${target} shots = one every ${(360 / target).toFixed(1)}° around the object.`}
        </div>

        {!error && (
          <div className="row">
            <button className={`btn small ${auto ? 'primary' : 'ghost'}`} onClick={() => setAuto((a) => !a)}>
              {auto ? 'Stop auto' : 'Auto every 3s'}
            </button>
            <span className="spacer" />
            <button className="shutter" onClick={shoot} aria-label="Take photo" disabled={saving} />
            <span className="spacer" />
            <button className="btn small primary" onClick={finish} disabled={saving}>
              {saving ? 'Saving…' : `Done (${total})`}
            </button>
          </div>
        )}
        {error && (
          <button className="btn primary block" onClick={() => navigate(`p/${projectId}`)}>
            Back to project
          </button>
        )}
      </div>
    </div>
  );
}
