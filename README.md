# 3dPrintMaster

Photograph an object from every side and get an STL you can slice and print. It is
a PWA: everything runs in the browser, nothing is uploaded, and it deploys to
GitHub Pages as a static site — no server, no Render, no build backend.

- **Scan an object** — 8 or more photos around a turntable become a solid 3D model.
- **Relief from one photo** — a single picture becomes a raised relief, a
  lithophane, or a flat cut-out.
- **Slice it** — a built-in FDM slicer turns any model, or any STL you open,
  into G-code for a FlashForge, with a layer-by-layer preview.
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

## The slicer

Save a model to a project and press **Slice**, or use **Slice an STL** on the home
screen to open any STL from the device. The output is plain G-code — no FlashPrint
in the middle.

What it does:

- Slices the mesh into layers, builds perimeters inside-out so the external wall
  lands last, and detects top and bottom surfaces by comparing each layer against
  the layers above and below (so solid material appears over holes and under
  ledges, not only at the very top and bottom).
- Rectilinear, grid or concentric infill; skirt and brim; retraction and Z hop.
- Support material under overhangs, with a Z gap so it snaps off.
- Estimates print time with a trapezoidal acceleration model, plus filament
  length and weight.
- A layer preview with a slider, colour-coded by what each move is doing.

Machine profiles cover the Adventurer 3, Adventurer 4, Adventurer 5M/5M Pro,
Creator Pro, Finder, Guider II and Dreamer, plus a generic FDM profile. Materials
cover PLA, PETG, ABS and TPU.

### Two things worth checking before you print

**Bed origin.** FlashForge's own firmware puts 0,0 at the *centre* of the bed, so
its G-code is full of negative coordinates; the Klipper-based Adventurer 5M uses
the front-left corner like most other printers. Each profile carries the right
setting and the slicer refuses to stay quiet if the toolpath leaves the bed, but
if you have a file FlashPrint exported for your machine, it is worth a glance to
confirm the convention matches.

**Start G-code.** Every profile ships a conservative start and end block. The
FlashForge-firmware profiles use `M132` after homing, the way FlashPrint does;
the Klipper profile leaves it out, because Klipper aborts on a command it does not
recognise rather than ignoring it. If your machine wants something specific, the
blocks live in `src/lib/slicer/machines.ts`.

### File formats

`.gcode` and `.g` contain identical text — use `.g` if your printer's menu ignores
`.gcode`. `.gx` wraps the same G-code in FlashPrint's container with an 80×60
thumbnail; that format is community-documented rather than official, so it is
offered as the fallback rather than the default. The G-code inside a `.gx` is byte
identical to the plain export, so renaming always gets you back to something that
works.

### What the slicer does not do

No multi-material, no variable layer height, no ironing or bridging detection, and
supports are a single uniform type rather than tree supports. Carved models stand
on a flat base and are mostly self-supporting, which is why supports default to
off.

## Printing on a FlashForge

Slice, save the file to a USB stick, put it in the printer and choose it from the
print menu. Or export the STL and open it in FlashPrint if you would rather use
that. Carved models print well with 10–15% infill and 2 perimeters. Reliefs and
lithophanes print flat on the bed with no supports.

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
- The slicer against primitives whose answers are known: a cube's cross-section
  area, a cylinder's area against the exact polygon area, a square tube producing
  two loops per layer.
- Layer planning: perimeter counts and ordering, sparse infill in the middle,
  solid top and bottom, and solid material appearing under a step rather than only
  at the top of the model.
- Supports: present under an overhanging table top, absent above it, never inside
  the model, and gone entirely when switched off.
- G-code: every coordinate on the bed, Z never descending, extrusion volume
  matching a solid block of known size, oversized models warned about, no
  FlashForge-only commands in Klipper output, and a true 3D scale changing
  material use as the cube of the factor.
- The `.gx` container: magic string, offsets, thumbnail size, and the G-code
  surviving byte for byte.

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
src/lib/slicer/         the FDM slicer: contours, perimeters, infill, supports,
                        G-code, machine profiles, the .gx container
src/lib/db.ts           IndexedDB project library
src/lib/captureGuide.ts the photo-count guidance shown throughout the UI
src/workers/            the reconstruction worker, so the UI never blocks
src/components/         library, project, camera capture, outline editor, 3D
                        viewer, slicer and layer preview
```

## Privacy

Photos, masks and models never leave the device. There is no analytics, no network
call after the app loads, and the only storage is your own browser's.
