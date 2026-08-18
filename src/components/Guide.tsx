import { CAPTURE_STEPS, MINIMUM_FOR_3D, RECOMMENDED } from '../lib/captureGuide';
import { useNavigate } from '../lib/useHashRoute';
import { AppBar } from './ui';
import { TierTable } from './CaptureMeter';

export function Guide() {
  const navigate = useNavigate();
  return (
    <>
      <AppBar title="How to get a good scan" subtitle="guide" onBack={() => navigate('')} />
      <main className="stack">
        <div className="card stack">
          <h2>How many photos?</h2>
          <p className="muted">
            <strong>{MINIMUM_FOR_3D} photos</strong> is the minimum for a true 3D print — one every 45° around the
            object. <strong>{RECOMMENDED}</strong> is the sweet spot. One photo can only ever make a relief, a
            lithophane or a flat cut-out, because a single picture contains no information about the far side.
          </p>
          <TierTable />
        </div>

        <div className="card stack">
          <h2>Shooting the object</h2>
          <ol className="steps">
            {CAPTURE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="callout info">
            The turntable trick: put the object on a plate or a lazy Susan and rotate the <em>object</em> rather than
            walking around it. The background then stays identical in every frame, which makes the outline detection
            far more reliable.
          </div>
        </div>

        <div className="card stack">
          <h2>How it builds the model</h2>
          <p className="muted">
            Each photo is reduced to a silhouette. The app then starts from a solid block and carves away everything
            that falls outside any silhouette — the classic “visual hull” or space-carving method. It runs entirely in
            your browser; no photo ever leaves the device.
          </p>
          <div className="callout warn">
            <strong>What it cannot do:</strong> silhouettes cannot see into hollows. The inside of a mug, a deep
            recess, or a hole that never breaks the outline will come out filled in. Convex-ish objects — figurines,
            tools, toys, rocks, shoes — reconstruct well.
          </div>
        </div>

        <div className="card stack">
          <h2>Printing on a FlashForge</h2>
          <ol className="steps">
            <li>Export the STL from a finished model and save it to your phone or computer.</li>
            <li>Open FlashPrint, then <em>Load</em> the STL. The model already arrives Z-up and standing on the bed.</li>
            <li>Scale it if you want a different size, then slice and save the resulting file to a USB stick.</li>
            <li>Put the stick in the printer and print from the USB menu.</li>
          </ol>
          <p className="faint">
            Carved models are solid shells with no interior detail, so 10–15% infill and 2 perimeters is usually
            plenty. Reliefs and lithophanes print best flat on the bed with no supports.
          </p>
        </div>

        <div className="card stack">
          <h2>Getting a cleaner result</h2>
          <ul className="steps">
            <li>Contrast matters more than resolution — a dark object on white paper beats a 48 MP photo of clutter.</li>
            <li>If an outline comes out wrong, open that photo and paint the fix in by hand; the carve uses it immediately.</li>
            <li>Keep the camera level with the middle of the object. If you shot from above, set the camera tilt in the project settings to match.</li>
            <li>If one photo is bad, exclude it rather than letting it eat into the model — a single wrong silhouette removes material everywhere.</li>
          </ul>
        </div>
      </main>
    </>
  );
}
