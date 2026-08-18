# 3dPrintMaster

Photograph an object from every side and get an STL you can slice and print. It is
a PWA: everything runs in the browser, nothing is uploaded, and it deploys to
GitHub Pages as a static site — no server, no Render, no build backend.

- **Scan an object** — 8 or more photos around a turntable become a solid 3D model.
- **Relief from one photo** — a single picture becomes a raised relief, a
  lithophane, or a flat cut-out.
- **Project library** — photos, silhouette edits and finished STLs are stored on
  the device in IndexedDB, so it keeps working offline.

## How many photos do I need?

This is the question that decides whether the result is worth printing, so the app
shows a readiness meter as you add photos.

| Photos | One shot every | Result |
| ---: | ---: | --- |
| 1 | — | Relief or lithophane only. A single photo contains no depth. |
| 2 | 90° | The intersection of a front and a side profile. Blocky keepsake. |
| 4 | 90° | Footprint captured, obvious flat facets at the corners. |
| **8** | **45°** | **The practical minimum for a real 3D print.** Recognisable, prints cleanly, mild faceting on curves. |
| 12 | 30° | Faceting mostly gone on rounded objects. |
| **16** | **22.5°** | **The sweet spot.** Smooth curves, quick to shoot and to carve. |
| 24 | 15° | Resolves thin features — handles, spouts, narrow gaps. |
| 36 | 10° | Maximum useful. Beyond this the remaining error is concavity, which outlines cannot see. |

## Shooting

1. Put the object on a plain surface that contrasts with it — paper, a plain tea
   towel, a mouse mat.
2. Keep the camera level with the middle of the object and hold that height.
3. Rotate the object by an even step and shoot again, all the way round.
4. Don't move closer, further away, or zoom between shots.
5. Avoid hard shadows pooling next to the object.

Rotating the *object* on a plate or lazy Susan beats walking around it: the
background stays identical in every frame, which makes outline detection far more
reliable.

## How it works

Each photo is reduced to a silhouette, then the app starts from a solid block and
carves away everything falling outside any silhouette — the classic **visual hull**
(space carving) method.

- **Silhouettes** (`src/lib/segment.ts`). Two independent readings compete for each
  photo: a *border-connectivity flood*, which asks whether a pixel can be reached
  from the frame edge without crossing a colour cliff (so vignetting, uneven
  lighting and soft shadows cost nothing to walk through), and a *colour-cluster
  model* learned from the frame border (which catches objects whose edges are too
  soft for the flood). Both run under two lightness weightings — one that treats a
  drop in lightness as a shadow, one that takes it at face value — and whichever
  splits the photo most decisively wins. Because every photo in a set is the same
  scene, the worker adds the scores up across the whole set and re-runs any photo
  that disagreed, so all the outlines are read the same way.
- **Carving** (`src/lib/carve.ts`). Silhouettes become signed distance fields, and
  a voxel's value is the smallest distance across all views. Carving with distances
  rather than a binary in/out test puts the surface between voxels instead of on a
  staircase. The camera model is orthographic with the object on a turntable, so no
  calibration is needed.
- **Surface extraction** (`src/lib/surfaceNets.ts`). Naive Surface Nets, chosen over
  marching cubes because it needs no 256-entry triangle table, always yields a
  watertight manifold, and looks smoother on voxel data.
- **Export** (`src/lib/stl.ts`). Binary STL, scaled to the requested size, rotated
  Z-up and sitting on the bed, ready for FlashPrint.

### What it cannot do

A visual hull cannot see concavities. The inside of a mug, a deep recess, or a hole
that never breaks the outline comes out filled in. Convex-ish objects — figurines,
tools, toys, rocks, shoes — reconstruct well.

## Printing on a FlashForge

Export the STL, open it in FlashPrint with *Load*, scale if you want, slice, save to
a USB stick and print from the printer's USB menu. Carved models are solid shells
with no interior detail, so 10–15% infill and 2 perimeters is usually plenty.
Reliefs and lithophanes print flat on the bed with no supports.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run selftest     # geometry + segmentation checks, no browser needed
npm run typecheck
npm run build        # runs selftest, typechecks, then builds
npm run bench        # timing for segmentation and carving
npm run test-photos  # render 16 synthetic turntable photos into test-photos/
npm run icons        # regenerate the PWA icons
```

`npm run test-photos` renders a synthetic object from 16 angles with a plain
backdrop and a soft contact shadow, which is enough to exercise the whole pipeline
without photographing anything.

### Tests

`npm run selftest` has no browser and no test framework — it bundles the real
modules with esbuild and checks them against known answers:

- Surface Nets against an analytic sphere (diameter, volume, outward normals,
  watertightness).
- Carving a cylinder and a rectangular block from synthetic silhouettes, checking
  the dimensions against the true shape and that more views converge from above.
- The export pipeline: scaling to millimetres, the Z-up rotation, STL byte layout,
  facet normals.
- Segmentation against eight hard scenes — a neutral object on white paper,
  contact shadows, a pale object on dark cloth, noisy and textured backdrops, an
  object running off the frame, soft out-of-focus edges.
- End to end: 16 rendered photos of a figure to a finished mesh, checking it stands
  on the bed, is the right way up, and has the right silhouette profile.

## Deploying to GitHub Pages

Push to `main`. `.github/workflows/deploy.yml` runs the self-test and type check,
builds with `--base=/<repository-name>/` so the asset URLs match the Pages URL, and
publishes `dist`. In the repository settings set **Pages → Source → GitHub Actions**
once, and the site appears at `https://<user>.github.io/<repository-name>/`.

The app uses hash routing (`#/p/<id>`) precisely so Pages never has to serve a path
it doesn't have a file for.

## Layout

```
src/lib/segment.ts      silhouette extraction and the signed distance transform
src/lib/carve.ts        visual-hull space carving
src/lib/surfaceNets.ts  isosurface extraction
src/lib/heightfield.ts  single-photo relief, lithophane and cut-out
src/lib/mesh.ts         smoothing, orientation, scaling to print size
src/lib/stl.ts          binary STL writer
src/lib/db.ts           IndexedDB project library
src/lib/captureGuide.ts the photo-count guidance shown throughout the UI
src/workers/            the reconstruction worker, so the UI never blocks
src/components/         library, project, camera capture, outline editor, 3D viewer
```

## Privacy

Photos, masks and models never leave the device. There is no analytics, no network
call after the app loads, and the only storage is your own browser's.
